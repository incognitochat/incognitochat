# CloudFront in front of the HTTPS API, and optionally a firewall in front of
# CloudFront. Floods can then be limited at the edge, before they reach
# Lambda, and a blocked request costs no invocation.
#
# var.api_access moves the API behind it in steps:
#
#   direct           the app calls the function URL (CloudFront exists, unused)
#   cloudfront       the app calls CloudFront; the function URL still answers
#   cloudfront-only  the function URL answers CloudFront alone: it requires
#                    AWS's signature, which CloudFront adds to each request
#
# Nothing is logged here: no access logs on the distribution, and no sampled
# requests in the firewall (they would hold IP addresses).

# CloudFront's firewalls live in us-east-1, whatever the app's region.
provider "aws" {
  alias  = "global"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "incognitochat"
      Environment = var.environment
      Stack       = "app"
      ManagedBy   = "terraform"
    }
  }
}

locals {
  api_behind_cloudfront = var.api_access != "direct"
  api_locked            = var.api_access == "cloudfront-only"
  # "https://<id>.lambda-url.<region>.on.aws/" -> the host.
  api_origin_host = trimsuffix(trimprefix(aws_lambda_function_url.api.function_url, "https://"), "/")
}

# The API's answers are never cached, and every header of the request goes on
# to the function (except Host, which must be the function URL's own).
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_but_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# CloudFront signs its requests to the function URL (SigV4), so the URL can
# require a signature and refuse everyone else without running the function.
resource "aws_cloudfront_origin_access_control" "api" {
  name                              = "${local.prefix}-api"
  description                       = "Signs CloudFront's requests to the api function URL"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "api" {
  enabled      = true
  comment      = "Incognito Chat API (${var.environment})"
  http_version = "http2and3"
  # IPv4 only, while the firewall limits per IP address: it counts each IPv6
  # address on its own, and one host can have billions of them. IPv6-only
  # devices still get here through their network's NAT64, as they reach the
  # socket API and the media bucket, which have no IPv6 addresses either.
  is_ipv6_enabled = false
  # The cheapest edge locations; every viewer is still served.
  price_class = "PriceClass_100"
  web_acl_id  = var.firewall ? aws_wafv2_web_acl.api[0].arn : null

  origin {
    origin_id                = "api"
    domain_name              = local.api_origin_host
    origin_access_control_id = local.api_locked ? aws_cloudfront_origin_access_control.api.id : null

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id         = "api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_but_host.id
    compress                 = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# CloudFront may call the function URL, for this distribution only. Both
# permissions are needed, as for a public URL (functions.tf).
resource "aws_lambda_permission" "cloudfront_url" {
  statement_id  = "CloudFrontUrl"
  action        = "lambda:InvokeFunctionUrl"
  function_name = aws_lambda_function.fn["api"].function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.api.arn
}

resource "aws_lambda_permission" "cloudfront_invoke" {
  statement_id  = "CloudFrontInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["api"].function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.api.arn
}

# The routes that need no login (backend/internal/api/api.go), by method, as
# patterns on the path. Each reads a table before any limit of its own (a
# login with a random device, a link or upload with a random ID), or is paid
# with a token but has no login (sends). Not here, though they need no login
# either: POST /media, which spends no table capacity on forged media tokens,
# and POST /media/{id}/delete, which the app sends for every received
# attachment of a deleted chat, six at a time without a pause. Both stay
# under rate-per-ip.
#
# The patterns are anchored at the end, and at the start only to a slash:
# NORMALIZE_PATH (below) keeps back-references at the start of a path, so
# "/../session" must count too. Another path that merely ends like one of
# these routes counts as well, which costs nothing (the API answers it 404).
locals {
  anonymous_routes = {
    GET  = "(^|/)(links|media)/[^/]+$"
    POST = "(^|/)(session|register|accounts/lookup|send|media/[^/]+/upload)$"
  }

  # Two limits over the same requests: per IP address, and for everyone
  # together (CONSTANT: every matching request goes into one count). Rules
  # run in priority order and a block ends the run, so what rate-per-ip or
  # anonymous-per-ip already blocks doesn't count towards anonymous-total.
  # But WAF checks rates only about every 10 seconds and usually acts within
  # 30, so until an address is blocked its burst counts in full: one host
  # alone can set anonymous-total off, and these routes are then refused for
  # everyone for a minute or two.
  anonymous_limits = {
    anonymous-per-ip = { priority = 2, key = "IP", limit = var.firewall_anonymous_rate_limit, window = 300 }
    anonymous-total  = { priority = 3, key = "CONSTANT", limit = var.firewall_anonymous_total_limit, window = 60 }
  }

  # A blocked request gets 429 and the API's own error, with CORS for the
  # app (the first of client_origins; the function URL answers each of them,
  # but a firewall response is fixed), so the app can tell being turned away
  # from being offline, and wait. Other origins see a network error.
  blocked_body   = "rate-limited"
  blocked_origin = var.client_origins[0]
}

# The firewall: three rate limits. $5 a month, plus $1 per rule and $0.60
# per million requests, so it is optional.
#
#   rate-per-ip       any route, per IP address. Many people can share one
#                     address (a mobile carrier, a VPN), so the limit is far
#                     above what one person's app sends.
#   anonymous-per-ip  the routes that need no login, per IP address: lower,
#                     since an app sends few requests there.
#   anonymous-total   the same routes, everyone together, over one minute:
#                     below what the directory table can serve, so a flood
#                     can't use up the capacity logged-in requests need.
#                     While it blocks, it blocks those routes for everyone,
#                     logins and sends included; requests with a session go
#                     on until it ends.
resource "aws_wafv2_web_acl" "api" {
  count    = var.firewall ? 1 : 0
  provider = aws.global

  name = "${local.prefix}-api"
  # WAF descriptions take no parentheses.
  description = "Rate limits for the Incognito Chat API, ${var.environment}"
  scope       = "CLOUDFRONT"

  # Turning the firewall off must first detach it from the distribution;
  # with this, Terraform updates the distribution before it deletes this.
  lifecycle {
    create_before_destroy = true
  }

  default_action {
    allow {}
  }

  custom_response_body {
    key          = local.blocked_body
    content      = jsonencode({ error = "rate_limited" })
    content_type = "APPLICATION_JSON"
  }

  rule {
    name     = "rate-per-ip"
    priority = 1

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = local.blocked_body

          response_header {
            name  = "Access-Control-Allow-Origin"
            value = local.blocked_origin
          }
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.firewall_rate_limit
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.prefix}-api-rate-per-ip"
      sampled_requests_enabled   = false
    }
  }

  dynamic "rule" {
    for_each = local.anonymous_limits

    content {
      name     = rule.key
      priority = rule.value.priority

      action {
        block {
          custom_response {
            response_code            = 429
            custom_response_body_key = local.blocked_body

            response_header {
              name  = "Access-Control-Allow-Origin"
              value = local.blocked_origin
            }
          }
        }
      }

      statement {
        rate_based_statement {
          limit                 = rule.value.limit
          aggregate_key_type    = rule.value.key
          evaluation_window_sec = rule.value.window

          scope_down_statement {
            or_statement {
              dynamic "statement" {
                for_each = local.anonymous_routes
                iterator = route

                content {
                  and_statement {
                    # In any letter case, as the router takes it.
                    statement {
                      byte_match_statement {
                        search_string         = lower(route.key)
                        positional_constraint = "EXACTLY"

                        field_to_match {
                          method {}
                        }

                        text_transformation {
                          priority = 0
                          type     = "LOWERCASE"
                        }
                      }
                    }

                    # Decoded and normalised first, so that a path written
                    # another way that could reach the same route matches
                    # too ("/%73ession", "//session", "/../session").
                    statement {
                      regex_match_statement {
                        regex_string = route.value

                        field_to_match {
                          uri_path {}
                        }

                        text_transformation {
                          priority = 0
                          type     = "URL_DECODE"
                        }

                        text_transformation {
                          priority = 1
                          type     = "NORMALIZE_PATH"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${local.prefix}-api-${rule.key}"
        sampled_requests_enabled   = false
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.prefix}-api"
    sampled_requests_enabled   = false
  }
}

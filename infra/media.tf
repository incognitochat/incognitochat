# Encrypted attachments (docs/protocol.md, Media). The app uploads ciphertext
# straight here with presigned URLs from the api function. An upload stays
# until the app deletes it (when its message is deleted) or it expires (below),
# so it can be fetched again meanwhile. Nothing in here can be read without the
# key in the encrypted message. The name, which presigned URLs and the app's
# security policy show, ends in random characters rather than the account ID.
# That doesn't keep the account ID secret: every presigned URL carries the api
# role's access key ID, which AWS maps to its account (sts:GetAccessKeyInfo).
resource "random_id" "media" {
  byte_length = 6
}

resource "aws_s3_bucket" "media" {
  bucket        = "${local.prefix}-media-${random_id.media.hex}"
  force_destroy = !var.deletion_protection
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Undelivered messages wait 30 days; so do their attachments (S3 deletes them
# at the next midnight UTC after that; the API stops handing out links at 30).
# No versioning, so a deleted attachment is gone.
resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# Browsers upload and download from the app's origin only. An upload sends
# If-None-Match: *, which its URL's signature requires, so it writes only
# once.
resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  cors_rule {
    allowed_origins = var.client_origins
    allowed_methods = ["PUT", "GET"]
    allowed_headers = ["content-type", "if-none-match"]
    max_age_seconds = 3600
  }
}

data "aws_iam_policy_document" "media" {
  statement {
    sid       = "TlsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.media.arn, "${aws_s3_bucket.media.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Presigned URLs only start a transfer within a minute of being signed
  # (backend/internal/media), since every request on one is billed. This
  # refuses any signature older than two minutes, should a longer URL ever
  # be signed. s3:signatureAge is in milliseconds and is set only for
  # presigned URLs.
  statement {
    sid       = "FreshPresignedUrlsOnly"
    effect    = "Deny"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "NumericGreaterThan"
      variable = "s3:signatureAge"
      values   = ["120000"]
    }
  }

  # Uploads only create: a PUT that creates an object must send
  # If-None-Match (backend/internal/media signs it into every upload URL), so
  # no later change can bring back overwrites unnoticed. Only object-creating
  # requests are covered: multipart part uploads can't carry the header. The
  # app is the only writer; nothing here copies objects (CopyObject would be
  # refused).
  statement {
    sid       = "CreateOnly"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.media.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["true"]
    }
    condition {
      test     = "Bool"
      variable = "s3:ObjectCreationOperation"
      values   = ["true"]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket     = aws_s3_bucket.media.id
  policy     = data.aws_iam_policy_document.media.json
  depends_on = [aws_s3_bucket_public_access_block.media]
}

# Request counts each minute (PutRequests, GetRequests and the rest) for the
# whole bucket. Uploads and downloads go straight here, past the API and its
# alarms; the alarms in infra/init/alerts.tf watch these, and find them by
# this name, since the bucket's own name is random. Billed as CloudWatch
# custom metrics, only for hours with requests.
resource "aws_s3_bucket_metric" "media" {
  bucket = aws_s3_bucket.media.id
  name   = "${local.prefix}-media"
}

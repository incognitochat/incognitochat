# Three tables, split because point-in-time recovery, TTL and IAM are set per
# table. All use pk/sk string keys and expire items through the "e" attribute
# (Unix seconds, rounded to the hour in directory and messages, and to the
# minute in ephemeral). TTL deletes can lag by days, so reads also filter
# expired items.
#
# Point-in-time recovery stays off everywhere: it would keep deleted data
# restorable for up to 35 days. Encryption at rest uses the AWS-owned key: the
# data that matters is already end-to-end encrypted.
locals {
  tables = {
    # Accounts, devices, device lists, links and their bundles, the mailbox
    # registry, invitations; and an index of accounts by the month they
    # were last used (below).
    directory = {}
    # Undelivered ciphertext, one item per message per device, keyed by the
    # recipient's account and device. No sender.
    messages = {}
    # Socket connections, rate counters, login nonces, spent tokens.
    ephemeral = {}
  }

  # Each table's caps, a second (variables.tf): the GitHub variables if
  # set, otherwise by environment.
  production            = var.environment == "production"
  table_max_read_units  = coalesce(var.table_max_read_units, local.production ? 400 : 200)
  table_max_write_units = coalesce(var.table_max_write_units, local.production ? 200 : 100)
}

resource "aws_dynamodb_table" "table" {
  for_each = local.tables

  name                        = "${local.prefix}-${each.key}"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  dynamic "attribute" {
    for_each = each.key == "directory" ? ["lu"] : []
    content {
      name = attribute.value
      type = "S"
    }
  }

  # The directory's account items by the month, UTC, each was last used
  # (lu, "2026-11"), which only account items have: the index holds their
  # keys and that month, nothing else. The account expiry reads it from the
  # oldest month on, so a run reads only the accounts it deletes
  # (backend/internal/directory, expiry.go; docs/data.md). Keys only, so
  # only a change of month (about once a month per account in use) writes
  # to it.
  dynamic "global_secondary_index" {
    for_each = each.key == "directory" ? [1] : []
    content {
      name            = "lastUse"
      projection_type = "KEYS_ONLY"

      key_schema {
        attribute_name = "sk"
        key_type       = "HASH"
      }

      key_schema {
        attribute_name = "lu"
        key_type       = "RANGE"
      }

      on_demand_throughput {
        max_read_request_units  = local.table_max_read_units
        max_write_request_units = local.table_max_write_units
      }
    }
  }

  ttl {
    attribute_name = "e"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false
  }

  on_demand_throughput {
    max_read_request_units  = local.table_max_read_units
    max_write_request_units = local.table_max_write_units
  }
}

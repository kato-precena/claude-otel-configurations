#!/bin/bash
# Issues a new 60-day CloudWatch API key per signal and stores it straight into Secrets Manager.
# The key is never printed. Usage: AWS_PROFILE=... AWS_REGION=... scripts/issue-keys.sh [logs|metrics]...
# Written for macOS's bash 3.2, so no associative arrays.
set -euo pipefail

spec() {
  case "$1" in
    logs)    echo "claude-otel-logs-writer logs.amazonaws.com claude-otel/logs-api-key" ;;
    metrics) echo "claude-otel-metrics-writer cloudwatch.amazonaws.com claude-otel/metrics-api-key" ;;
    *) echo "unknown signal: $1 (use logs or metrics)" >&2; return 2 ;;
  esac
}

[[ $# -eq 0 ]] && set -- logs metrics

for s in "$@"; do
  line=$(spec "$s")
  read -r user service secret <<<"$line"

  count=$(aws iam list-service-specific-credentials --user-name "$user" --service-name "$service" \
    --query 'length(ServiceSpecificCredentials)' --output text)
  if [[ "$count" -ge 2 ]]; then
    echo "$s: already has 2 keys. Delete the expired one first (docs/key-rotation.md step 2)." >&2
    exit 1
  fi

  key=$(aws iam create-service-specific-credential --user-name "$user" --service-name "$service" \
    --credential-age-days 60 --query 'ServiceSpecificCredential.ServiceCredentialSecret' --output text)
  aws secretsmanager put-secret-value --secret-id "$secret" --secret-string "$key" >/dev/null
  unset key
  echo "$s: new key stored in $secret"
done

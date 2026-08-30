#!/bin/sh
set -eu

ip_address=182.92.85.15
certificate_name=182.92.85.15
certificate_dir=/etc/nginx/ssl/token-talk-ip

[ "$(basename "${RENEWED_LINEAGE:-missing}")" = "$certificate_name" ] || exit 0

install -d -m 700 "$certificate_dir"
certificate_tmp="$(mktemp "$certificate_dir/.server.crt.XXXXXX")"
key_tmp="$(mktemp "$certificate_dir/.server.key.XXXXXX")"
trap 'rm -f "$certificate_tmp" "$key_tmp"' EXIT HUP INT TERM

install -m 644 "$RENEWED_LINEAGE/fullchain.pem" "$certificate_tmp"
install -m 600 "$RENEWED_LINEAGE/privkey.pem" "$key_tmp"
openssl x509 -in "$certificate_tmp" -noout -checkip "$ip_address"

certificate_key="$(openssl x509 -in "$certificate_tmp" -pubkey -noout | openssl pkey -pubin -outform der | sha256sum | cut -d' ' -f1)"
private_key="$(openssl pkey -in "$key_tmp" -pubout -outform der | sha256sum | cut -d' ' -f1)"
[ "$certificate_key" = "$private_key" ] || { echo "certificate and private key do not match" >&2; exit 1; }

mv -f "$key_tmp" "$certificate_dir/server.key"
mv -f "$certificate_tmp" "$certificate_dir/server.crt"
trap - EXIT HUP INT TERM

nginx -t
systemctl reload nginx

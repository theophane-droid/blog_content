# Basics network proto
@load base/protocols/conn
@load base/protocols/dns
@load base/protocols/http
@load base/protocols/ssl
@load base/protocols/smtp
@load base/protocols/ftp
@load base/protocols/ssh

# File detection
@load base/frameworks/files

# Notices / alerting
@load base/frameworks/notice

# Intelligence basique
@load policy/protocols/ssl/validate-certs
@load policy/protocols/http/detect-webapps

# Logging enrichi
@load policy/protocols/conn/vlan-logging
@load policy/misc/capture-loss


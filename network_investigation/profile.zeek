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

# Load ja3 & ja4
@load ja3
@load ja4

# Files
@load base/frameworks/files

# Extract all files
redef FileExtract::default_limit = 0;
redef FileExtract::prefix = "extract_files"; 

event file_new(f: fa_file)
    {
    Files::add_analyzer(f, Files::ANALYZER_EXTRACT);
    }

# Microsoft proto
@load base/protocols/dce-rpc
@load base/protocols/smb
@load base/protocols/krb
@load base/protocols/ntlm
@load base/protocols/rdp

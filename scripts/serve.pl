#!/usr/bin/perl
# Zero-dependency static file server for previewing the site locally.
#
#   perl scripts/serve.pl [port] [root]
#
# Defaults: port 8123, root "." (the repo). Then open http://127.0.0.1:8123/
# Handy on Windows via Git Bash (which ships Perl) when Node/Python aren't installed.
use strict;
use warnings;
use IO::Socket::INET;
use IO::Select;

my $port = $ARGV[0] || 8123;
my $root = $ARGV[1] || '.';
$root =~ s{[\\/]+$}{};

my %mime = (
  html => 'text/html; charset=utf-8',
  js   => 'text/javascript; charset=utf-8',
  mjs  => 'text/javascript; charset=utf-8',
  css  => 'text/css; charset=utf-8',
  json => 'application/json; charset=utf-8',
  svg  => 'image/svg+xml', png => 'image/png', jpg => 'image/jpeg',
  ico  => 'image/x-icon', webmanifest => 'application/manifest+json',
  txt  => 'text/plain; charset=utf-8',
);

my $srv = IO::Socket::INET->new(
  LocalAddr => '127.0.0.1', LocalPort => $port, Proto => 'tcp',
  Listen => 128, ReuseAddr => 1, Blocking => 0,
) or die "Cannot listen on $port: $!";
my $sel = IO::Select->new($srv);
my (%buf, %atime);
$| = 1;
print "Serving $root at http://127.0.0.1:$port  (Ctrl+C to stop)\n";

sub close_client { my $fh = shift; $sel->remove($fh); delete $buf{$fh}; delete $atime{$fh}; close $fh; }

sub serve {
  my ($fh, $reqline) = @_;
  $fh->blocking(1);
  my ($path) = $reqline =~ m{^GET\s+(\S+)\s+HTTP};
  $path //= '/';
  $path =~ s/\?.*//; $path =~ s/%20/ /g; $path =~ s{\.\.}{}g;
  $path = '/index.html' if $path eq '/';
  my $file = $root . $path;
  if (-f $file) {
    my ($ext) = $file =~ /\.([^.]+)$/;
    my $type = $mime{lc($ext || '')} || 'application/octet-stream';
    if (open my $rf, '<:raw', $file) {
      local $/; my $body = <$rf>; close $rf;
      print $fh "HTTP/1.1 200 OK\r\nContent-Type: $type\r\nContent-Length: "
              . length($body) . "\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n" . $body;
      return;
    }
  }
  my $body = "404 Not Found: $path";
  print $fh "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: "
          . length($body) . "\r\nConnection: close\r\n\r\n$body";
}

while (1) {
  my @ready = $sel->can_read(1);
  my $now = time;
  for my $fh (@ready) {
    if ($fh == $srv) {
      while (my $c = $srv->accept) { $c->blocking(0); $sel->add($c); $buf{$c} = ''; $atime{$c} = $now; }
    } else {
      my $data; my $n = sysread($fh, $data, 8192);
      if (!defined $n) { next; }
      if ($n == 0) { close_client($fh); next; }
      $buf{$fh} .= $data; $atime{$fh} = $now;
      if ($buf{$fh} =~ /\r?\n\r?\n/) { serve($fh, $buf{$fh}); close_client($fh); }
    }
  }
  for my $fh ($sel->handles) { next if $fh == $srv; close_client($fh) if $now - ($atime{$fh} || $now) > 5; }
}

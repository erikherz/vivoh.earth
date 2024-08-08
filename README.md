FIRST SET UP AN API SERVER
```
1 touch API-VIVOH-EARTH
2 sudo apt update
3 sudo apt install redis nginx python3-certbot-nginx
4 sudo certbot --nginx -d REPLACE_WITH_API_DOMAIN.vivoh.earth
5 wget https://releases.vivoh.com/assets/moq-api [OR SET UP RUST AND BUILD IT AS PER BELOW]
6 chmod +x moq-api
7 sudo vi /etc/systemd/system/moq-api.service
8 sudo systemctl enable moq-api
9 sudo systemctl start moq-api
10 sudo vi /etc/nginx/sites-enabled/default 
11 sudo systemctl restart nginx

[Unit]
Description=MOQ API
After=network.target
[Service]
Type=simple
WorkingDirectory=/home/ubuntu
ExecStart=/home/ubuntu/moq-api --bind 0.0.0.0:8888 --redis redis://localhost:6379
Restart=always
RestartSec=1
SyslogIdentifier=moq-api
[Install]
WantedBy=multi-user.target

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name REPLACE_WITH_API_DOMAIN.vivoh.earth;
    root /var/www/html;
    index index.html index.htm index.nginx-debian.html;

    location / {
        proxy_pass http://localhost:8888;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    ssl_certificate /etc/letsencrypt/live/REPLACE_WITH_API_DOMAIN.vivoh.earth/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/REPLACE_WITH_API_DOMAIN.vivoh.earth/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}
```
    NEXT SET UP A RELAY
  ```  
    1  touch XXX-VIVOH-EARTH
    2  sudo apt update
    3  sudo apt install build-essential pkg-config libssl-dev nginx certbot python3-certbot-nginx npm ffmpeg python3-certbot-dns-cloudflare
    4 sudo vi /etc/letsencrypt/cloudflare.ini
    	dns_cloudflare_api_token = REPLACE_WITH_YOUR_CF_API_TOKEN
    5 sudo chmod 600 /etc/letsencrypt/cloudflare.ini
    6 sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini -d '*.vivoh.earth' -d 'vivoh.earth'
    7  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
    8  . "$HOME/.cargo/env"
    9  sudo vi /etc/nginx/sites-available/default  [SEE NGINX CONFIG BELOW]
   10  cd /var/www/html
   11  sudo git clone https://github.com/erikherz/moq-js.git [Generic Repo: sudo git clone https://github.com/kixelated/moq-js.git ]
   12  cd moq-js/
   13  sudo npm install
   14 sudo vi web/.env.production
   15 cd /var/www/html/moq-js
   16  sudo npm run build 
   17  cd ~
   18  git clone https://github.com/kixelated/moq-rs.git
   19  cd moq-rs/
   20  cargo build --release
   21  sudo vi /etc/systemd/system/astro.service   [SEE ASTRO SERVICE CONFIG BELOW]
   22  sudo systemctl enable astro
   23  sudo systemctl start astro
   24  sudo vi /etc/systemd/system/moq.service   [SEE MOQ SERVICE CONFIG BELOW]
   25  sudo systemctl enable moq
   26  sudo systemctl start moq
   27  sudo systemctl restart nginx

NGINX CONF:
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name REPLACE_WITH_NODE_DOMAIN.vivoh.earth;
    ssl_certificate /etc/letsencrypt/live/vivoh.earth/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vivoh.earth/privkey.pem;
    # include /etc/letsencrypt/options-ssl-nginx.conf;
    #ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    # Root directory for static files
    root /var/www/html/moq-js/web/dist/client;
    # Add security headers
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    # Try to serve static files first, then proxy to SSR
    location / {
        try_files $uri $uri/ @ssr;
    }
    # Proxy all requests to SSR server
    location @ssr {
        proxy_pass http://127.0.0.1:4321;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    # Enable directory listing for debugging (remove in production)
    autoindex on;
    # Increase the log level for debugging
    error_log /var/log/nginx/REPLACE_WITH_NODE_DOMAIN.vivoh.earth_error.log debug;
    access_log /var/log/nginx/REPLACE_WITH_NODE_DOMAIN.vivoh.earth_access.log;
}


[Unit]
Description=Astro Web Application
After=network.target
[Service]
Type=simple
User=ubuntu
WorkingDirectory=/var/www/html/moq-js
ExecStart=/usr/bin/node /var/www/html/moq-js/web/dist/server/entry.mjs
Restart=always
RestartSec=1
SyslogIdentifier=astro-app
[Install]
WantedBy=multi-user.target

[Unit]
Description=MOQ Relay
After=network.target
[Service]
Type=simple
WorkingDirectory=/home/ubuntu
ExecStart=/home/ubuntu/moq-rs/target/release/moq-relay --bind 0.0.0.0:443 --tls-cert /etc/letsencrypt/live/vivoh.earth/fullchain.pem --tls-key /etc/letsencrypt/live/vivoh.earth/privkey.pem --api https://REPLACE_WITH_API_DOMAIN.vivoh.earth --node https://REPLACE_WITH_NODE_DOMAIN.vivoh.earth
Restart=always
RestartSec=1
SyslogIdentifier=moq-relay
[Install]
WantedBy=multi-user.target
```

ffmpeg -hide_banner -v quiet -stream_loop -1 -re -i af.mp4 -c copy -f mp4 -movflags cmaf+separate_moof+delay_moov+skip_trailer+frag_every_frame - | RUST_LOG=moq_pub=info /home/ubuntu/moq-rs/target/release/moq-pub --name "REPLACE_WITH_STREAM_NAME" "https://REPLACE_WITH_ORIGIN_DOMAIN.vivoh.earth" "$@"

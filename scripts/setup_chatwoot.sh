#!/bin/bash
# Chatwoot ilk kurulum yardımcısı
set -e

echo "=== Chatwoot DB Migration ==="
docker compose exec chatwoot_rails bundle exec rails db:chatwoot_prepare

echo ""
echo "=== Admin Kullanıcı Oluştur ==="
read -p "Admin email: " EMAIL
read -p "Admin şifre: " PASS
read -p "Admin adı: " NAME

docker compose exec chatwoot_rails bundle exec rails runner "
  User.create!(
    name: '${NAME}',
    email: '${EMAIL}',
    password: '${PASS}',
    role: :administrator,
    account_id: 1,
    confirmed_at: Time.now
  )
  puts 'Kullanıcı oluşturuldu!'
"

echo ""
echo "✓ Chatwoot hazır → http://localhost:3000"

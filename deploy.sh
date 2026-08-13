#!/bin/bash

# Deployment script for crypto-bot
# Usage: ./deploy.sh

set -e  # Exit on error

echo "🚀 Starting crypto-bot deployment..."

# Navigate to project directory
cd /root/crypto-bot

# Pull latest changes
echo "📥 Pulling latest changes from GitHub..."
git pull origin main

# Clean and install dependencies
echo "📦 Installing dependencies..."
rm -rf node_modules package-lock.json
npm install
npm rebuild

# Restart bot with PM2
echo "🔄 Restarting bot..."
pm2 restart crypto-bot 2>/dev/null || pm2 start bot.js --name "crypto-bot"
pm2 save

# Show status
echo ""
echo "✅ Deployment complete!"
echo "📊 Dashboard: http://145.223.116.178:4000"
echo ""
pm2 logs crypto-bot

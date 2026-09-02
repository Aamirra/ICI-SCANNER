#!/bin/bash
echo "Pulling latest changes from GitHub..."
git pull origin main

echo "Installing dependencies..."
npm install

echo "Restarting application with PM2..."
pm2 restart ici-scanner

echo "Deployment completed successfully!"

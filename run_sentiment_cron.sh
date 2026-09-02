#!/bin/bash
cd /home/ubuntu/ICI-SCANNER
/usr/bin/python3 crypto_sentiment.py >> /home/ubuntu/ICI-SCANNER/crypto_sentiment.log 2>&1
/usr/bin/python3 stocks_sentiment.py >> /home/ubuntu/ICI-SCANNER/stocks_sentiment.log 2>&1

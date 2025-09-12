import dotenv from 'dotenv';

dotenv.config();
dotenv.config({ path: './.env.secret' });

import express from 'express';
import fs from 'fs';
import http from 'http';
import https from 'https';
import cron from 'node-cron';
import { migrateProductList, syncOrder, syncProductList } from './controllers/index.js';

const app = express(); // Create an Express application instance

app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Server is running',
    status: 'ok'
  });
});

// Upload Order data from Shopify store whenever an order is paid
app.post('/api/orders/upload', async (req, res) => {
  try {
    var origin_shopifyStore = process.env["SHOPIFYSTORES"].split(",").find(storeName=>req.headers["x-shopify-shop-domain"] == process.env[`${storeName}_SHOPIFY_STORE_DOMAIN`]);

    if(!origin_shopifyStore)throw {
      status_code: 400,
      message: "Cannot find origin Store!"
    };

    if(req.body.financial_status != "paid")throw {
      status_code: 400,
      message: "Order not paid yet!"
    };

    const sync_result = await syncOrder({
      order: req.body,
      store: origin_shopifyStore
    });

    if(sync_result.status != "success")throw {
      status_code: sync_result.error.status,
      message: sync_result.error.message
    };
    
    res.status(200).json({
      status: "success",
      message: "Order Synced"
    });
  } catch (error) {
    console.log("sync_order_error", error);
    res.status(error.status_code || 400).json({
      status: "error",
      message: error.message
    });
  }
});

console.log("Tracking Product Updates every day at 12AM and 12PM.....");
cron.schedule('0 0,12 * * *', async () => {
  //sync products in Diamond
  await syncProductList({ storeName: "DIAMOND", frequency: "halfday" });
});

console.log("Tracking Product Updates every hour.....");
cron.schedule('0 * * * *', async () => {
  //sync products in Diamond
  await syncProductList({ storeName: "DIAMOND", frequency: "hourly" });
});

const sslOptions = {
  key: fs.readFileSync(process.env.SSL_KEY_PATH),
  cert: fs.readFileSync(process.env.SSL_CERT_PATH)
};

// HTTP server (port 80)
http.createServer(app).listen(80, () => {
  console.log('HTTP server running on port 80');
});

// HTTPS server (port 443)
https.createServer(sslOptions, app).listen(443, () => {
  console.log('HTTPS server running on port 443');
});
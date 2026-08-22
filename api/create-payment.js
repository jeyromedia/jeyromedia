// api/create-payment.js
// Cryptomus ödeme oluşturma uç noktası — Vercel Serverless Function.
// Bu dosya YALNIZCA sunucu tarafında çalışır. CRYPTOMUS_API_KEY hiçbir zaman
// tarayıcıya / client koduna gönderilmez.

const crypto = require("crypto");

// index.html içindeki PRODUCTS listesiyle BİREBİR aynı tutulmalıdır.
// "ozel" (anlaşmalı fiyat) kasıtlı olarak burada yok: fiyatı, sipariş öncesinde
// müşteri ile anlaşılan ve değişken bir tutardır, sabit bir katalog fiyatı değildir.
const PRODUCT_PRICES = {
  hazir: 15,
  sifirdan: 20,
  efektli: 25,
  "3d": 30,
  araba: 30,
  isletme: 50,
};

const OZEL_MIN_AMOUNT = 1;
const OZEL_MAX_AMOUNT = 100000; // makul bir üst sınır; hatalı/kötüye kullanım isteklerini engeller
const MAX_QTY_PER_ITEM = 50;

function sendJson(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// Sepet toplamını YALNIZCA sunucudaki sabit fiyat tablosundan hesaplar.
// Client'tan gelen herhangi bir "price" alanı varsa tamamen yok sayılır.
function computeServerSideTotal(cart, ozelAmount) {
  if (!cart || typeof cart !== "object") {
    throw new Error("invalid_cart");
  }

  const ids = Object.keys(cart);
  if (ids.length === 0) {
    throw new Error("empty_cart");
  }

  let total = 0;

  for (const id of ids) {
    const qty = Number(cart[id]);
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY_PER_ITEM) {
      throw new Error("invalid_quantity");
    }

    if (id === "ozel") {
      const amount = Number(ozelAmount);
      if (
        !Number.isFinite(amount) ||
        amount < OZEL_MIN_AMOUNT ||
        amount > OZEL_MAX_AMOUNT
      ) {
        throw new Error("invalid_ozel_amount");
      }
      total += Math.round(amount * 100) * qty;
    } else {
      const unitPrice = PRODUCT_PRICES[id];
      if (unitPrice === undefined) {
        throw new Error("unknown_product");
      }
      total += unitPrice * 100 * qty;
    }
  }

  return total / 100; // kuruş bazlı topladık, ondalık yuvarlama hatalarını önlemek için
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  const API_KEY = process.env.CRYPTOMUS_API_KEY;
  const MERCHANT_ID = process.env.CRYPTOMUS_USER_ID;
  const SITE_DOMAIN =
    process.env.SITE_DOMAIN || process.env.NEXT_PUBLIC_SITE_DOMAIN;

  if (!API_KEY || !MERCHANT_ID || !SITE_DOMAIN) {
    console.error(
      "Eksik ortam değişkeni: CRYPTOMUS_API_KEY / CRYPTOMUS_USER_ID / SITE_DOMAIN kontrol edin."
    );
    return sendJson(res, 500, { error: "server_misconfigured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return sendJson(res, 400, { error: "invalid_json" });
    }
  }
  if (!body || typeof body !== "object") {
    return sendJson(res, 400, { error: "invalid_body" });
  }

  let total;
  try {
    total = computeServerSideTotal(body.cart, body.ozelAmount);
  } catch (e) {
    return sendJson(res, 400, { error: e.message || "invalid_cart" });
  }

  if (!total || total <= 0) {
    return sendJson(res, 400, { error: "empty_cart" });
  }

  const orderId =
    "jeyro-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
  const domain = String(SITE_DOMAIN).replace(/\/+$/, "");

  const payload = {
    amount: total.toFixed(2),
    currency: "USD",
    order_id: orderId,
    url_return: domain + "/index.html?payment=cancelled#order",
    url_success: domain + "/index.html?payment=success#order",
  };

  const base64Payload = Buffer.from(JSON.stringify(payload)).toString(
    "base64"
  );
  const sign = crypto
    .createHash("md5")
    .update(base64Payload + API_KEY)
    .digest("hex");

  try {
    const cryptomusRes = await fetch("https://api.cryptomus.com/v1/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        merchant: MERCHANT_ID,
        sign: sign,
      },
      body: JSON.stringify(payload),
    });

    const data = await cryptomusRes.json();

    if (
      !cryptomusRes.ok ||
      data.state !== 0 ||
      !data.result ||
      !data.result.url
    ) {
      console.error("Cryptomus hata yanıtı:", data);
      return sendJson(res, 502, { error: "payment_provider_error" });
    }

    return sendJson(res, 200, { url: data.result.url, order_id: orderId });
  } catch (err) {
    console.error("Cryptomus isteği başarısız:", err);
    return sendJson(res, 502, { error: "payment_provider_unreachable" });
  }
};

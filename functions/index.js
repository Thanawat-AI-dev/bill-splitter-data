const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

// Set with: firebase functions:secrets:set GEMINI_API_KEY
// Never committed to source — this is the whole point of this proxy.
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// Keep this list in sync with GEMINI_MODELS in app.js. Only these IDs are
// accepted from the client so a forged request can't pick an arbitrary
// (possibly more expensive) model.
const ALLOWED_MODELS = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3-flash-preview"];

// Same schema/rules as the old client-side RECEIPT_VISION_PROMPT in app.js —
// kept here now that the Gemini call happens server-side.
const RECEIPT_VISION_PROMPT = `You are bill-receipt-reader, a receipt OCR assistant for a bill-splitting web app.

Read the attached receipt/bill image and respond with ONLY a single valid JSON object — no markdown code fences, no explanation, no text before or after — matching exactly this schema:
{
  "billName": "",
  "place": "",
  "date": "",
  "totalDiscount": 0,
  "serviceChargePercent": 0,
  "vatPercent": 0,
  "items": [ { "name": "", "price": 0 } ],
  "notes": []
}

Rules:
- billName / place: shop name if readable, else "".
- date: format YYYY-MM-DD, or "" if unreadable.
- totalDiscount / serviceChargePercent / vatPercent: plain numbers, no % or currency symbols, 0 if none.
- items: only food/drink/product line items. Exclude subtotal, total, discount, service charge, VAT, table number, order number, receipt number, and payment method lines.
- If a line has a quantity (e.g. 2 x 50), use the line total (100), not the unit price.
- price must be a plain number — no commas, no currency symbols.
- Never invent items or prices that aren't in the image.
- If part of a number or word is unclear, use your best reading and add a note in "notes" flagging which item should be double-checked.
- If the image is not a receipt or cannot be read at all, return the schema above with empty items and a note explaining why.`;

// ~12MB source image, base64-inflated (~33%) — matches the client-side guard
// in app.js's callGeminiReceiptVision, checked again here in case that
// client-side check is ever bypassed.
const MAX_BASE64_CHARS = 16 * 1024 * 1024;

exports.scanReceipt = onCall(
  { secrets: [GEMINI_API_KEY], timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ต้องเข้าสู่ระบบก่อนใช้งาน AI อ่านบิล");
    }
    const { imageBase64, mimeType, model } = request.data || {};
    if (!imageBase64 || typeof imageBase64 !== "string") {
      throw new HttpsError("invalid-argument", "ไม่พบข้อมูลรูปภาพ");
    }
    if (imageBase64.length > MAX_BASE64_CHARS) {
      throw new HttpsError("invalid-argument", "รูปใหญ่เกินไป");
    }
    const chosenModel = ALLOWED_MODELS.includes(model) ? model : ALLOWED_MODELS[0];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${chosenModel}:generateContent`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY.value(),
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } },
              { text: RECEIPT_VISION_PROMPT },
            ],
          }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      });
    } catch (e) {
      logger.error("Gemini fetch failed", e);
      throw new HttpsError("unavailable", "เชื่อมต่อ AI ไม่สำเร็จ ลองใหม่อีกครั้ง");
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // 429 = rate limit / quota exceeded on the selected model — the most
      // actionable fix is switching to a different model in the dropdown,
      // so say that explicitly instead of surfacing the raw API error.
      if (res.status === 429) {
        throw new HttpsError(
          "resource-exhausted",
          `โมเดล "${chosenModel}" ติดลิมิตการใช้งานชั่วคราว — กรุณาเปลี่ยนโมเดลในเมนู "โมเดล AI" แล้วลองใหม่`
        );
      }
      logger.error("Gemini API error", { status: res.status, data });
      throw new HttpsError("internal", (data && data.error && data.error.message) || `เรียก AI ไม่สำเร็จ (HTTP ${res.status})`);
    }

    const parts = (((data && data.candidates) || [])[0]?.content?.parts) || [];
    const textPart = parts.find((p) => typeof p.text === "string");
    if (!textPart) {
      const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
      throw new HttpsError("internal", blocked ? `AI ปฏิเสธคำขอ (${blocked})` : "AI ไม่ได้ตอบเป็นข้อความ");
    }

    let jsonText = textPart.text.trim();
    const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();

    try {
      return JSON.parse(jsonText);
    } catch (e) {
      throw new HttpsError("internal", "AI ตอบไม่เป็น JSON ที่ถูกต้อง");
    }
  }
);

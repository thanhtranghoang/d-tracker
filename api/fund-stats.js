module.exports = async (req, res) => {
  // CORS + cache cho Vercel
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const TIMO_VERIFY_CODE = process.env.TIMO_VERIFY_CODE || "1iyeys6er88q9";
  const TARGET_AMOUNT = Number(process.env.TARGET_AMOUNT || 270000000);

  const TIMO_TXN_URL = "https://app2.timo.vn/moneypots/public/txn";

  const headers = {
    "Content-Type": "application/json; charset=UTF-8",
    "Accept": "application/json, text/plain",
    "Accept-Language": "en",
    "Origin": "https://share.timo.vn",
    "Referer": "https://share.timo.vn/",
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36"
  };

  // Nếu bạn lấy được Payload thật trong DevTools, cho vào env:
  // TIMO_TXN_PAYLOAD={"verifyCode":"1iyeys6er88q9","page":0,"size":1000}
  const payloadCandidates = [];

  if (process.env.TIMO_TXN_PAYLOAD) {
    try {
      payloadCandidates.push(JSON.parse(process.env.TIMO_TXN_PAYLOAD));
    } catch (e) {
      console.warn("TIMO_TXN_PAYLOAD không phải JSON hợp lệ:", e.message);
    }
  }

  payloadCandidates.push(
    { verifyCode: TIMO_VERIFY_CODE, size: 1000 },
    { verifyCode: TIMO_VERIFY_CODE, page: 0, size: 1000 },
    { verifyCode: TIMO_VERIFY_CODE, pageNumber: 0, pageSize: 1000 },
    { code: TIMO_VERIFY_CODE, size: 1000 },
    { moneyPotCode: TIMO_VERIFY_CODE, size: 1000 }
  );

  function pickArray(obj) {
    if (!obj || typeof obj !== "object") return [];

    return (
      obj.transactions ||
      obj.txnHistories ||
      obj.data?.transactions ||
      obj.data?.txnHistories ||
      obj.data?.content ||
      obj.data?.items ||
      obj.content ||
      obj.items ||
      obj.result?.transactions ||
      obj.result?.txnHistories ||
      []
    );
  }

  function getAmount(t) {
    const raw =
      t.amount ??
      t.txnAmount ??
      t.transactionAmount ??
      t.creditAmount ??
      t.value ??
      0;

    if (typeof raw === "number") return raw;

    return Number(
      String(raw)
        .replace(/[^\d.-]/g, "")
        .trim()
    ) || 0;
  }

  function getName(t) {
    return (
      t.counterpartName ||
      t.senderName ||
      t.fullName ||
      t.name ||
      t.fromName ||
      t.accountName ||
      "Ẩn danh"
    );
  }

  function getDesc(t) {
    return (
      t.description ||
      t.memo ||
      t.content ||
      t.txnDesc ||
      t.remark ||
      ""
    );
  }

  function getTime(t) {
    return (
      t.txnDate ||
      t.createdAt ||
      t.date ||
      t.transactionDate ||
      t.time ||
      null
    );
  }

  try {
    let lastDebug = null;
    let txnData = null;
    let rawTxns = [];

    for (const payload of payloadCandidates) {
      const timoRes = await fetch(TIMO_TXN_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      const contentType = timoRes.headers.get("content-type") || "";
      const text = await timoRes.text();

      lastDebug = {
        url: TIMO_TXN_URL,
        status: timoRes.status,
        contentType,
        payload,
        bodyPreview: text.slice(0, 800)
      };

      if (!timoRes.ok) continue;

      try {
        txnData = JSON.parse(text);
      } catch (e) {
        lastDebug.parseError = e.message;
        continue;
      }

      rawTxns = pickArray(txnData);

      if (Array.isArray(rawTxns)) {
        break;
      }
    }

    if (!Array.isArray(rawTxns)) {
      throw new Error(
        "Timo trả dữ liệu không đúng định dạng giao dịch. Debug: " +
          JSON.stringify(lastDebug)
      );
    }

    // Nếu trả 200 nhưng không có giao dịch, vẫn trả JSON để frontend không crash
    let totalAmount = 0;
    const donorMap = {};
    const amounts = [];

    const incomingTxns = rawTxns.filter((t) => getAmount(t) > 0);

    const transactions = incomingTxns.map((t) => {
      const amt = getAmount(t);
      totalAmount += amt;
      amounts.push(amt);

      let nameForTop = getName(t).trim().toUpperCase();
      donorMap[nameForTop] = (donorMap[nameForTop] || 0) + amt;

      return {
        name: getName(t),
        desc: getDesc(t),
        amount: amt,
        time: getTime(t)
      };
    });

    const topDonors = Object.entries(donorMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, amount], i) => ({
        rank: i + 1,
        name,
        amount
      }));

    const avgAmount = incomingTxns.length
      ? totalAmount / incomingTxns.length
      : 0;

    const maxAmount = amounts.length ? Math.max(...amounts) : 0;

    res.status(200).json({
      success: true,
      totalAmount,
      targetAmount: TARGET_AMOUNT,
      transactions: transactions.slice(0, 50),
      topDonors,
      txnCount: incomingTxns.length,
      avgAmount,
      maxAmount,

      // Tạm để debug. Khi chạy ổn rồi có thể xóa dòng này.
      debug: {
        source: TIMO_TXN_URL,
        rawCount: rawTxns.length
      }
    });
  } catch (error) {
    console.error("Lỗi API Vercel:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

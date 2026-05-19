module.exports = async (req, res) => {
  // =========================================
  // CORS
  // =========================================

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // =========================================
  // CONFIG
  // =========================================

  // Tổng quỹ hiện tại (set tay)
  // KHÔNG tự cộng thêm fetched txns
  const BASE_TOTAL_AMOUNT = Number(
    process.env.BASE_TOTAL_AMOUNT || 84384318
  );

  // Goal
  const TARGET_AMOUNT = Number(
    process.env.TARGET_AMOUNT || 270000000
  );

  // Tính top donor từ ngày này
  const TOP_DONOR_FROM_DATE =
    process.env.TOP_DONOR_FROM_DATE || "2026-05-18";

  // Hash verify code
  const HASH_VERIFY_CODE =
    process.env.TIMO_HASH_VERIFY_CODE ||
    "8e5a81d78e1eec11082e66ca9bd5a85b6c7a89c6f803a66a0fc0d219745c2a5f85294ef81454db81f695b76fadecbb59ee58264e4cf545765bb6b690eba6ebed";

  const TIMO_TXN_URL =
    "https://app2.timo.vn/moneypots/public/txn";

  // =========================================
  // REQUEST HEADERS
  // =========================================

  const headers = {
    "Content-Type": "application/json; charset=UTF-8",
    Accept: "application/json, text/plain",
    "Accept-Language": "en",
    Origin: "https://share.timo.vn",
    Referer: "https://share.timo.vn/",
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36"
  };

  // =========================================
  // HELPERS
  // =========================================

  function parseGroupDate(dispDate) {
    if (!dispDate) return null;

    const now = new Date();

    if (dispDate === "Hôm nay") {
      return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
      );
    }

    if (dispDate === "Hôm qua") {
      return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - 1
      );
    }

    const m = String(dispDate).match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
    );

    if (m) {
      return new Date(
        Number(m[3]),
        Number(m[2]) - 1,
        Number(m[1])
      );
    }

    return null;
  }

  function pickTransactions(obj) {
    const histories =
      obj?.data?.txnHistories ||
      obj?.txnHistories ||
      [];

    if (!Array.isArray(histories)) {
      return [];
    }

    return histories.flatMap((group) => {
      const items =
        group.item ||
        group.items ||
        [];

      if (!Array.isArray(items)) {
        return [];
      }

      return items.map((txn) => ({
        ...txn,
        _groupDate: parseGroupDate(group.dispDate),
        _groupDateText: group.dispDate || ""
      }));
    });
  }

  function getAmount(txn) {
    const raw =
      txn.txnAmount ??
      txn.amount ??
      0;

    if (typeof raw === "number") {
      return raw;
    }

    return (
      Number(
        String(raw).replace(/[^\d.-]/g, "")
      ) || 0
    );
  }

  function getName(txn) {
    const raw =
      txn.txnTitle ||
      txn.senderName ||
      txn.name ||
      "Ẩn danh";

    return String(raw)
      .replace(/^Từ\s+/i, "")
      .replace(/^VND-TGTT-/i, "")
      .trim();
  }

  function getDesc(txn) {
    return (
      txn.txnDesc ||
      txn.description ||
      ""
    );
  }

  function getTime(txn) {
    return (
      txn._groupDateText ||
      txn.txnDate ||
      txn.createdAt ||
      ""
    );
  }

  function isAfterStartDate(txn) {
    if (!txn._groupDate) {
      return false;
    }

    const start = new Date(
      TOP_DONOR_FROM_DATE + "T00:00:00+07:00"
    );

    return (
      txn._groupDate.getTime() >=
      start.getTime()
    );
  }

  async function fetchPage(xidIndex) {
    const payload = {
      size: 100,
      xidIndex,
      hashVerifyCode: HASH_VERIFY_CODE,
      lang: "VN"
    };

    const response = await fetch(
      TIMO_TXN_URL,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      }
    );

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Timo API HTTP ${response.status}`
      );
    }

    let json;

    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(
        `Cannot parse JSON`
      );
    }

    return {
      json,
      txns: pickTransactions(json),
      preview: text.slice(0, 500)
    };
  }

  // =========================================
  // MAIN
  // =========================================

  try {
    let rawTxns = [];

    let firstPreview = "";

    const seen = new Set();

    // Fetch nhiều page
    for (let xidIndex = 0; xidIndex <= 30; xidIndex++) {
      const page = await fetchPage(xidIndex);

      if (xidIndex === 0) {
        firstPreview = page.preview;
      }

      if (!page.txns.length) {
        break;
      }

      for (const txn of page.txns) {
        const key = JSON.stringify({
          title: txn.txnTitle,
          desc: txn.txnDesc,
          amount: txn.txnAmount,
          remain: txn.remainingAmount,
          date: txn._groupDateText
        });

        if (!seen.has(key)) {
          seen.add(key);
          rawTxns.push(txn);
        }
      }

      if (page.txns.length < 100) {
        break;
      }
    }

    // Chỉ lấy giao dịch cộng tiền
    const incomingTxns = rawTxns.filter(
      (txn) => getAmount(txn) > 0
    );

    // =========================================
    // TOTAL
    // =========================================

    // Tổng hiện tại set tay
    // KHÔNG auto cộng thêm txns
    const totalAmount = BASE_TOTAL_AMOUNT;

    // =========================================
    // TRANSACTIONS
    // =========================================

    const transactions = incomingTxns.map(
      (txn) => ({
        name: getName(txn),
        desc: getDesc(txn),
        amount: getAmount(txn),
        time: getTime(txn)
      })
    );

    // =========================================
    // TOP DONORS
    // =========================================

    const donorMap = {};

    const topDonorTxns = incomingTxns.filter(
      isAfterStartDate
    );

    for (const txn of topDonorTxns) {
      const amount = getAmount(txn);

      const donorName = getName(txn)
        .trim()
        .toUpperCase();

      donorMap[donorName] =
        (donorMap[donorName] || 0) +
        amount;
    }

    const topDonors = Object.entries(donorMap)
      .map(([name, amount]) => ({
        name,
        amount
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);

    // =========================================
    // STATS
    // =========================================

    const fetchedAmount = incomingTxns.reduce(
      (sum, txn) =>
        sum + getAmount(txn),
      0
    );

    const avgAmount = incomingTxns.length
      ? fetchedAmount /
        incomingTxns.length
      : 0;

    const maxAmount = incomingTxns.length
      ? Math.max(
          ...incomingTxns.map((txn) =>
            getAmount(txn)
          )
        )
      : 0;

    // =========================================
    // RESPONSE
    // =========================================

    return res.status(200).json({
      success: true,

      totalAmount,

      targetAmount: TARGET_AMOUNT,

      transactions: transactions.slice(
        0,
        50
      ),

      topDonors,

      txnCount: incomingTxns.length,

      avgAmount,

      maxAmount,

      debug: {
        source: TIMO_TXN_URL,

        baseAmount:
          BASE_TOTAL_AMOUNT,

        fetchedAmount,

        rawCount: rawTxns.length,

        incomingCount:
          incomingTxns.length,

        topDonorFromDate:
          TOP_DONOR_FROM_DATE,

        firstResponsePreview:
          firstPreview
      }
    });
  } catch (error) {
    console.error(
      "Vercel API Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

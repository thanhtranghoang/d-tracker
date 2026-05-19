module.exports = async (req, res) => {
  // =========================
  // CONFIG
  // =========================

  // Tổng donate lịch sử đã chốt
  // Các donate mới fetch từ Timo sẽ cộng thêm vào số này
  const BASE_TOTAL_AMOUNT = Number(
    process.env.BASE_TOTAL_AMOUNT || 84263113
  );

  // Mục tiêu quỹ
  const TARGET_AMOUNT = Number(
    process.env.TARGET_AMOUNT || 270000000
  );

  // Chỉ tính top donor từ ngày này trở đi
  const TOP_DONOR_FROM_DATE =
    process.env.TOP_DONOR_FROM_DATE || "2026-05-18";

  // Hash verify code của Timo
  const HASH_VERIFY_CODE =
    process.env.TIMO_HASH_VERIFY_CODE ||
    "8e5a81d78e1eec11082e66ca9bd5a85b6c7a89c6f803a66a0fc0d219745c2a5f85294ef81454db81f695b76fadecbb59ee58264e4cf545765bb6b690eba6ebed";

  const TIMO_TXN_URL =
    "https://app2.timo.vn/moneypots/public/txn";

  // =========================
  // HEADERS
  // =========================

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // =========================
  // REQUEST HEADERS
  // =========================

  const headers = {
    "Content-Type": "application/json; charset=UTF-8",
    Accept: "application/json, text/plain",
    "Accept-Language": "en",
    Origin: "https://share.timo.vn",
    Referer: "https://share.timo.vn/",
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36"
  };

  // =========================
  // HELPERS
  // =========================

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
      const day = Number(m[1]);
      const month = Number(m[2]) - 1;
      const year = Number(m[3]);

      return new Date(year, month, day);
    }

    return null;
  }

  function pickTransactions(obj) {
    if (!obj || typeof obj !== "object") return [];

    const histories =
      obj?.data?.txnHistories ||
      obj?.txnHistories ||
      [];

    if (!Array.isArray(histories)) return [];

    return histories.flatMap((group) => {
      const groupDate = parseGroupDate(group.dispDate);

      const items =
        group.item ||
        group.items ||
        [];

      if (!Array.isArray(items)) return [];

      return items.map((t) => ({
        ...t,
        _groupDate: groupDate,
        _groupDateText: group.dispDate || ""
      }));
    });
  }

  function getAmount(t) {
    const raw =
      t.txnAmount ??
      t.amount ??
      0;

    if (typeof raw === "number") return raw;

    return (
      Number(
        String(raw).replace(/[^\d.-]/g, "")
      ) || 0
    );
  }

  function getName(t) {
    const raw =
      t.txnTitle ||
      t.senderName ||
      t.name ||
      "Ẩn danh";

    return String(raw)
      .replace(/^Từ\s+/i, "")
      .trim();
  }

  function getDesc(t) {
    return (
      t.txnDesc ||
      t.description ||
      ""
    );
  }

  function getTime(t) {
    return (
      t._groupDateText ||
      t.txnDate ||
      t.createdAt ||
      null
    );
  }

  function isAfterStartDate(txn) {
    const start = new Date(
      TOP_DONOR_FROM_DATE + "T00:00:00+07:00"
    );

    if (!txn._groupDate) return false;

    return txn._groupDate.getTime() >= start.getTime();
  }

  async function fetchPage(xidIndex) {
    const payload = {
      size: 100,
      xidIndex,
      hashVerifyCode: HASH_VERIFY_CODE,
      lang: "VN"
    };

    const response = await fetch(TIMO_TXN_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Timo API HTTP ${response.status}: ${text.slice(0, 500)}`
      );
    }

    let json;

    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(
        `Cannot parse Timo JSON: ${text.slice(0, 500)}`
      );
    }

    return {
      json,
      txns: pickTransactions(json),
      preview: text.slice(0, 500)
    };
  }

  // =========================
  // MAIN
  // =========================

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
      (t) => getAmount(t) > 0
    );

    // =========================
    // TOTAL DONATE
    // =========================

    // Donate mới fetch được
    const fetchedAmount = incomingTxns.reduce(
      (sum, t) => sum + getAmount(t),
      0
    );

    // Tổng donate cuối cùng
    const totalAmount =
      BASE_TOTAL_AMOUNT + fetchedAmount;

    // =========================
    // TRANSACTIONS
    // =========================

    const transactions = incomingTxns.map((t) => ({
      name: getName(t),
      desc: getDesc(t),
      amount: getAmount(t),
      time: getTime(t)
    }));

    // =========================
    // TOP DONOR
    // =========================

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
        (donorMap[donorName] || 0) + amount;
    }

    const topDonors = Object.entries(donorMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, amount], i) => ({
        rank: i + 1,
        name,
        amount
      }));

    // =========================
    // STATS
    // =========================

    const avgAmount = incomingTxns.length
      ? fetchedAmount / incomingTxns.length
      : 0;

    const maxAmount = incomingTxns.length
      ? Math.max(
          ...incomingTxns.map((t) => getAmount(t))
        )
      : 0;

    // =========================
    // RESPONSE
    // =========================

    return res.status(200).json({
      success: true,

      totalAmount,
      targetAmount: TARGET_AMOUNT,

      transactions: transactions.slice(0, 50),

      topDonors,

      txnCount: incomingTxns.length,

      avgAmount,
      maxAmount,

      debug: {
        source: TIMO_TXN_URL,

        baseAmount: BASE_TOTAL_AMOUNT,

        fetchedAmount,

        totalAmount,

        rawCount: rawTxns.length,

        incomingCount: incomingTxns.length,

        topDonorFromDate:
          TOP_DONOR_FROM_DATE,

        firstResponsePreview:
          firstPreview
      }
    });
  } catch (error) {
    console.error("Vercel API Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

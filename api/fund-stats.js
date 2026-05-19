module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // =========================
  // CONFIG
  // =========================

  // Mốc tổng donate đã chốt:
  // 19/05/2026 13:40 GMT+7
  const BASE_RAISED_AMOUNT = Number(
    process.env.BASE_RAISED_AMOUNT || 84452318
  );

  // Balance tại thời điểm chốt mốc.
  // Thường bằng BASE_RAISED_AMOUNT nếu chưa rút quỹ.
  const CHECKPOINT_BALANCE = Number(
    process.env.CHECKPOINT_BALANCE || 84452318
  );

  const RAISED_TRACK_FROM_DATETIME =
    process.env.RAISED_TRACK_FROM_DATETIME || "2026-05-19T13:40:00+07:00";

  const TARGET_AMOUNT = Number(
    process.env.TARGET_AMOUNT || 270000000
  );

  const TOP_DONOR_FROM_DATE =
    process.env.TOP_DONOR_FROM_DATE || "2026-05-18";

  const HASH_VERIFY_CODE =
    process.env.TIMO_HASH_VERIFY_CODE ||
    "8e5a81d78e1eec11082e66ca9bd5a85b6c7a89c6f803a66a0fc0d219745c2a5f85294ef81454db81f695b76fadecbb59ee58264e4cf545765bb6b690eba6ebed";

  const TIMO_TXN_URL = "https://app2.timo.vn/moneypots/public/txn";

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
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

    if (dispDate === "Hôm qua") {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    }

    const m = String(dispDate).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

    if (m) {
      return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    }

    return null;
  }

  function pickTransactions(obj) {
    const histories =
      obj?.data?.txnHistories ||
      obj?.txnHistories ||
      obj?.result?.txnHistories ||
      [];

    if (!Array.isArray(histories)) return [];

    return histories.flatMap((group) => {
      const items =
        group.item ||
        group.items ||
        group.transactions ||
        [];

      if (!Array.isArray(items)) return [];

      return items.map((txn) => ({
        ...txn,
        _groupDate: parseGroupDate(group.dispDate),
        _groupDateText: group.dispDate || ""
      }));
    });
  }

  function toNumber(raw) {
    if (typeof raw === "number") return raw;

    return (
      Number(
        String(raw ?? "")
          .replace(/[^\d.-]/g, "")
          .trim()
      ) || 0
    );
  }

  function getSignedAmount(txn) {
    return toNumber(
      txn.txnAmount ??
      txn.amount ??
      txn.transactionAmount ??
      txn.value ??
      0
    );
  }

  function getAmount(txn) {
    return Math.abs(getSignedAmount(txn));
  }

  function getRemainingAmount(txn) {
    return toNumber(txn.remainingAmount ?? txn.balance ?? 0);
  }

  function getName(txn) {
    const raw =
      txn.txnTitle ||
      txn.counterpartName ||
      txn.senderName ||
      txn.fullName ||
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
      txn.memo ||
      txn.content ||
      txn.remark ||
      ""
    );
  }

  function getTime(txn) {
    return (
      txn._groupDateText ||
      txn.txnDate ||
      txn.createdAt ||
      txn.date ||
      txn.transactionDate ||
      ""
    );
  }

  function hasPreciseTime(txn) {
    return Boolean(
      txn.txnDate ||
      txn.createdAt ||
      txn.date ||
      txn.transactionDate ||
      txn.time
    );
  }

  function getPreciseDate(txn) {
    const raw =
      txn.txnDate ||
      txn.createdAt ||
      txn.date ||
      txn.transactionDate ||
      txn.time ||
      null;

    if (!raw) return null;

    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function isOnOrAfterTopDonorDate(txn) {
    if (!txn._groupDate) return false;

    const start = new Date(TOP_DONOR_FROM_DATE + "T00:00:00+07:00");

    return txn._groupDate.getTime() >= start.getTime();
  }

  function isAfterRaisedTrackDate(txn) {
    const start = new Date(RAISED_TRACK_FROM_DATETIME);

    if (hasPreciseTime(txn)) {
      const d = getPreciseDate(txn);
      return d ? d.getTime() > start.getTime() : false;
    }

    // Nếu Timo chỉ trả "Hôm nay" / ngày, không có giờ,
    // fallback an toàn: chỉ tính các ngày sau ngày checkpoint.
    // Cùng ngày 19/05/2026 sẽ được ưu tiên xử lý bằng balance-boundary bên dưới.
    if (!txn._groupDate) return false;

    const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());

    return txn._groupDate.getTime() > startDay.getTime();
  }

  function approxEqual(a, b) {
    return Math.abs(Number(a) - Number(b)) < 1;
  }

  function findTransactionsAfterCheckpoint(allTxns) {
    // Timo trả mới nhất trước. Dùng remainingAmount để tìm giao dịch đầu tiên
    // sau mốc 13:40: previousBalance = remainingAfter - signedAmount.
    // Khi previousBalance == CHECKPOINT_BALANCE thì đó là giao dịch đầu sau checkpoint.
    let boundaryIndex = -1;

    for (let i = 0; i < allTxns.length; i++) {
      const txn = allTxns[i];
      const remaining = getRemainingAmount(txn);
      const signedAmount = getSignedAmount(txn);

      if (!remaining || !signedAmount) continue;

      const previousBalance = remaining - signedAmount;

      if (approxEqual(previousBalance, CHECKPOINT_BALANCE)) {
        boundaryIndex = i;
      }
    }

    if (boundaryIndex >= 0) {
      return allTxns.slice(0, boundaryIndex + 1);
    }

    // Fallback nếu không tìm được boundary bằng balance.
    return allTxns.filter(isAfterRaisedTrackDate);
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
      throw new Error(`Timo API HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    let json;

    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Error(`Cannot parse Timo JSON: ${text.slice(0, 300)}`);
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
    const rawTxns = [];
    const seen = new Set();
    let firstPreview = "";

    for (let xidIndex = 0; xidIndex <= 30; xidIndex++) {
      const page = await fetchPage(xidIndex);

      if (xidIndex === 0) {
        firstPreview = page.preview;
      }

      if (!page.txns.length) break;

      for (const txn of page.txns) {
        const key = JSON.stringify({
          title: txn.txnTitle || "",
          desc: txn.txnDesc || "",
          amount: txn.txnAmount ?? txn.amount ?? "",
          remain: txn.remainingAmount ?? "",
          date: txn._groupDateText || ""
        });

        if (!seen.has(key)) {
          seen.add(key);
          rawTxns.push(txn);
        }
      }

      if (page.txns.length < 100) break;
    }

    const incomingTxns = rawTxns.filter((txn) => getSignedAmount(txn) > 0);

    // Số dư realtime hiện tại: lấy remainingAmount của giao dịch mới nhất.
    let currentBalance = BASE_RAISED_AMOUNT;

    if (rawTxns.length > 0) {
      const latestBalance = getRemainingAmount(rawTxns[0]);

      if (latestBalance > 0) {
        currentBalance = latestBalance;
      }
    }

    // Tổng donate tích lũy: chỉ tăng sau mốc checkpoint.
    const txnsAfterCheckpoint = findTransactionsAfterCheckpoint(rawTxns);

    const raisedDelta = txnsAfterCheckpoint
      .filter((txn) => getSignedAmount(txn) > 0)
      .reduce((sum, txn) => sum + getSignedAmount(txn), 0);

    const totalRaisedAmount = BASE_RAISED_AMOUNT + raisedDelta;

    const transactions = incomingTxns.map((txn) => ({
      name: getName(txn),
      desc: getDesc(txn),
      amount: getSignedAmount(txn),
      time: getTime(txn)
    }));

    const donorMap = {};
    const topDonorTxns = incomingTxns.filter(isOnOrAfterTopDonorDate);

    for (const txn of topDonorTxns) {
      const donorName = getName(txn).trim().toUpperCase();
      const amount = getSignedAmount(txn);

      donorMap[donorName] = (donorMap[donorName] || 0) + amount;
    }

    const topDonors = Object.entries(donorMap)
      .map(([name, amount], index) => ({
        rank: index + 1,
        name,
        amount
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10)
      .map((d, index) => ({
        ...d,
        rank: index + 1
      }));

    const fetchedAmount = incomingTxns.reduce(
      (sum, txn) => sum + getSignedAmount(txn),
      0
    );

    const avgAmount = incomingTxns.length
      ? fetchedAmount / incomingTxns.length
      : 0;

    const maxAmount = incomingTxns.length
      ? Math.max(...incomingTxns.map((txn) => getSignedAmount(txn)))
      : 0;

    return res.status(200).json({
      success: true,

      // Alias cho HTML cũ.
      totalAmount: totalRaisedAmount,

      // Field mới.
      totalRaisedAmount,
      currentBalance,

      targetAmount: TARGET_AMOUNT,

      transactions: transactions.slice(0, 50),
      topDonors,

      txnCount: incomingTxns.length,
      avgAmount,
      maxAmount,

      debug: {
        source: TIMO_TXN_URL,
        baseRaisedAmount: BASE_RAISED_AMOUNT,
        checkpointBalance: CHECKPOINT_BALANCE,
        raisedTrackFromDateTime: RAISED_TRACK_FROM_DATETIME,
        raisedDelta,
        totalRaisedAmount,
        currentBalance,
        fetchedAmount,
        rawCount: rawTxns.length,
        incomingCount: incomingTxns.length,
        txnsAfterCheckpointCount: txnsAfterCheckpoint.length,
        topDonorFromDate: TOP_DONOR_FROM_DATE,
        firstResponsePreview: firstPreview
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

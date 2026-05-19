module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const TARGET_AMOUNT = Number(process.env.TARGET_AMOUNT || 270000000);

  const TIMO_TXN_URL = "https://app2.timo.vn/moneypots/public/txn";

  const HASH_VERIFY_CODE =
    process.env.TIMO_HASH_VERIFY_CODE ||
    "8e5a81d78e1eec11082e66ca9bd5a85b6c7a89c6f803a66a0fc0d219745c2a5f85294ef81454db81f695b76fadecbb59ee58264e4cf545765bb6b690eba6ebed";

  const headers = {
    "Content-Type": "application/json; charset=UTF-8",
    Accept: "application/json, text/plain",
    "Accept-Language": "en",
    Origin: "https://share.timo.vn",
    Referer: "https://share.timo.vn/",
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36"
  };

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
      t.money ??
      0;

    if (typeof raw === "number") return raw;

    return (
      Number(
        String(raw)
          .replace(/[^\d.-]/g, "")
          .trim()
      ) || 0
    );
  }

  function getName(t) {
    return (
      t.counterpartName ||
      t.senderName ||
      t.fullName ||
      t.name ||
      t.fromName ||
      t.accountName ||
      t.sender ||
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
      t.message ||
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

  async function fetchPage(xidIndex) {
    const payload = {
      size: 100,
      xidIndex,
      hashVerifyCode: HASH_VERIFY_CODE,
      lang: "VN"
    };

    const timoRes = await fetch(TIMO_TXN_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const text = await timoRes.text();

    if (!timoRes.ok) {
      throw new Error(
        `Timo trả HTTP ${timoRes.status}: ${text.slice(0, 500)}`
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Không parse được JSON từ Timo: ${text.slice(0, 500)}`);
    }

    return {
      data,
      rawTxns: pickArray(data),
      debug: {
        payload,
        status: timoRes.status,
        bodyPreview: text.slice(0, 500)
      }
    };
  }

  try {
    // Lấy trang đầu tiên
    const first = await fetchPage(0);
    let rawTxns = Array.isArray(first.rawTxns) ? first.rawTxns : [];

    // Nếu Timo phân trang bằng xidIndex, thử lấy thêm vài trang sau.
    // Nếu không có dữ liệu thêm thì dừng.
    let xidIndex = 1;
    while (xidIndex <= 10) {
      const next = await fetchPage(xidIndex);
      const nextTxns = Array.isArray(next.rawTxns) ? next.rawTxns : [];

      if (!nextTxns.length) break;

      rawTxns = rawTxns.concat(nextTxns);

      if (nextTxns.length < 100) break;

      xidIndex++;
    }

    let totalAmount = 0;
    const donorMap = {};
    const amounts = [];

    const incomingTxns = rawTxns.filter((t) => getAmount(t) > 0);

    const transactions = incomingTxns.map((t) => {
      const amt = getAmount(t);
      totalAmount += amt;
      amounts.push(amt);

      const donorName = getName(t);
      const nameForTop = donorName.trim().toUpperCase();
      donorMap[nameForTop] = (donorMap[nameForTop] || 0) + amt;

      return {
        name: donorName,
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
      debug: {
        source: TIMO_TXN_URL,
        rawCount: rawTxns.length,
        incomingCount: incomingTxns.length,
        firstResponsePreview: first.debug.bodyPreview
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

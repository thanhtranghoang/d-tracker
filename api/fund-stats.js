module.exports = async (req, res) => {
  // CORS + cache
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

    const direct =
      obj.transactions ||
      obj.data?.transactions ||
      obj.content ||
      obj.items ||
      obj.data?.content ||
      obj.data?.items ||
      obj.result?.transactions ||
      [];

    if (Array.isArray(direct) && direct.length) {
      return direct;
    }

    const histories =
      obj.txnHistories ||
      obj.data?.txnHistories ||
      obj.result?.txnHistories ||
      [];

    if (Array.isArray(histories)) {
      return histories.flatMap((group) => {
        if (Array.isArray(group.item)) return group.item;
        if (Array.isArray(group.items)) return group.items;
        if (Array.isArray(group.transactions)) return group.transactions;
        return [];
      });
    }

    return [];
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
    const title =
      t.counterpartName ||
      t.senderName ||
      t.fullName ||
      t.name ||
      t.fromName ||
      t.accountName ||
      t.sender ||
      t.txnTitle ||
      "Ẩn danh";

    return String(title).replace(/^Từ\s+/i, "").trim();
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
      t.dispDate ||
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
      throw new Error(`Timo trả HTTP ${timoRes.status}: ${text.slice(0, 500)}`);
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
    let rawTxns = [];
    let firstPreview = "";
    const seen = new Set();

    for (let xidIndex = 0; xidIndex <= 10; xidIndex++) {
      const page = await fetchPage(xidIndex);

      if (xidIndex === 0) {
        firstPreview = page.debug.bodyPreview;
      }

      const pageTxns = Array.isArray(page.rawTxns) ? page.rawTxns : [];

      if (!pageTxns.length) {
        break;
      }

      for (const txn of pageTxns) {
        const key = JSON.stringify({
          title: txn.txnTitle || txn.counterpartName || txn.senderName || "",
          desc: txn.txnDesc || txn.description || txn.memo || "",
          amount: txn.txnAmount || txn.amount || "",
          remain: txn.remainingAmount || "",
          time: txn.txnDate || txn.createdAt || txn.date || ""
        });

        if (!seen.has(key)) {
          seen.add(key);
          rawTxns.push(txn);
        }
      }

      if (pageTxns.length < 100) {
        break;
      }
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
        firstResponsePreview: firstPreview
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

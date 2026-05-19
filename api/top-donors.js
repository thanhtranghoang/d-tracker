module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const HASH_VERIFY_CODE =
    process.env.TIMO_HASH_VERIFY_CODE ||
    "8e5a81d78e1eec11082e66ca9bd5a85b6c7a89c6f803a66a0fc0d219745c2a5f85294ef81454db81f695b76fadecbb59ee58264e4cf545765bb6b690eba6ebed";

  const TOP_DONOR_FROM_DATE =
    process.env.TOP_DONOR_FROM_DATE || "2026-05-18";

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

  function getAmount(txn) {
    return toNumber(
      txn.txnAmount ??
      txn.amount ??
      txn.transactionAmount ??
      txn.value ??
      0
    );
  }

  function normalizeName(name) {
    return String(name || "Ẩn danh")
      .replace(/^Từ\s+/i, "")
      .replace(/^VND-TGTT-/i, "")
      .replace(/^MOMOIBFT/i, "MOMO")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();
  }

  function getName(txn) {
    return normalizeName(
      txn.txnTitle ||
      txn.counterpartName ||
      txn.senderName ||
      txn.fullName ||
      txn.name ||
      "Ẩn danh"
    );
  }

  function isOnOrAfterStartDate(txn) {
    if (!txn._groupDate) return false;

    const start = new Date(TOP_DONOR_FROM_DATE + "T00:00:00+07:00");

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
      throw new Error(`Timo API HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Cannot parse Timo JSON: ${text.slice(0, 300)}`);
    }
  }

  try {
    const allTxns = [];
    const seen = new Set();

    for (let xidIndex = 0; xidIndex <= 30; xidIndex++) {
      const json = await fetchPage(xidIndex);
      const txns = pickTransactions(json);

      if (!txns.length) break;

      for (const txn of txns) {
        const key = JSON.stringify({
          title: txn.txnTitle || "",
          desc: txn.txnDesc || "",
          amount: txn.txnAmount ?? txn.amount ?? "",
          remain: txn.remainingAmount ?? "",
          date: txn._groupDateText || ""
        });

        if (!seen.has(key)) {
          seen.add(key);
          allTxns.push(txn);
        }
      }

      if (txns.length < 100) break;
    }

    const validTxns = allTxns.filter(
      (txn) => getAmount(txn) > 0 && isOnOrAfterStartDate(txn)
    );

    const donorMap = {};

    for (const txn of validTxns) {
      const name = getName(txn);
      const amount = getAmount(txn);

      donorMap[name] = (donorMap[name] || 0) + amount;
    }

    const donors = Object.entries(donorMap)
      .map(([name, amount]) => ({
        name,
        amount
      }))
      .sort((a, b) => b.amount - a.amount);

    const top3 = donors.slice(0, 3);

    const over5m = donors.filter((d) => d.amount >= 5000000);
    const over2m = donors.filter((d) => d.amount >= 2000000);

    return res.status(200).json({
      success: true,
      top3,
      over5m,
      over2m,
      donorCount: donors.length,
      debug: {
        rawTxnCount: allTxns.length,
        validTxnCount: validTxns.length,
        fromDate: TOP_DONOR_FROM_DATE
      }
    });
  } catch (error) {
    console.error("Top donors API error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

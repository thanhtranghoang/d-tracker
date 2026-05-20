let TOP_DONORS_CACHE = null;
let TOP_DONORS_CACHE_TIME = 0;

const TOP_DONORS_CACHE_TTL = Number(
  process.env.TOP_DONORS_CACHE_TTL || 300_000
);

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const forceRefresh = req.query?.refresh === "1";

  if (
    !forceRefresh &&
    TOP_DONORS_CACHE &&
    Date.now() - TOP_DONORS_CACHE_TIME < TOP_DONORS_CACHE_TTL
  ) {
    return res.status(200).json({
      ...TOP_DONORS_CACHE,
      cached: true,
      cacheAgeMs: Date.now() - TOP_DONORS_CACHE_TIME
    });
  }

  const PAGE_SIZE = Number(process.env.TIMO_PAGE_SIZE || 100);
  const MAX_PAGES = Number(process.env.MAX_TIMO_PAGES || 50);

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

  function cleanText(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripTransferPrefix(text) {
    return cleanText(text)
      .replace(/^(tu|từ)\s+/i, "")
      .replace(/^vnd[\s-]*tgtt[\s-]*/i, "")
      .replace(/^vnd[\s-]*/i, "")
      .replace(/^--+/i, "")
      .replace(/^\s*-\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeName(name) {
    return stripTransferPrefix(name || "Ẩn danh")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();
  }

  function isGenericPaymentTitle(title) {
    const t = normalizeName(title);

    return (
      t === "MOMOIBFT" ||
      t === "MOMO" ||
      t === "MBBANK IBFT" ||
      t === "MB BANK IBFT" ||
      t === "ZION" ||
      t === "SHOPEEPAY" ||
      t.includes("CONG TY CO PHAN ZION") ||
      t.includes("CONG TY CO PHAN SHOPEEPAY") ||
      t.includes("SHOPEEPAY") ||
      t.includes("ZION")
    );
  }

  function removeTransferCodes(desc) {
    return cleanText(desc)
      .replace(/\bFT\d{8,}\b/gi, "")
      .replace(/\bZP\d{8,}\b/gi, "")
      .replace(/\bMBVCB\.[^.]+\.[^.]+\./gi, "")
      .replace(/\bCT tu\b.*$/gi, "")
      .replace(/\b[0-9A-Z]{12,}\b/g, "")
      .replace(/\bchuyen tien qua momo\b/gi, "")
      .replace(/\bchuyen tien\b/gi, "")
      .replace(/\bscan qr\b/gi, "")
      .replace(/\bung ho\b/gi, "")
      .replace(/\bdonate\b/gi, "")
      .replace(/\bsupport\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function inferNameFromDesc(desc, fallbackChannel) {
    const cleaned = removeTransferCodes(desc);

    if (!cleaned) return fallbackChannel;

    const words = cleaned.split(/\s+/).filter(Boolean);

    const stopWords = new Set([
      "chuc",
      "pn",
      "phuc",
      "nguyen",
      "uprize",
      "debut",
      "light",
      "up",
      "the",
      "sky",
      "gui",
      "cho",
      "ung",
      "ho",
      "project",
      "prj",
      "support",
      "donate",
      "mua",
      "tra",
      "flag",
      "bill",
      "cam",
      "on",
      "iu",
      "yeu",
      "thuong",
      "thanh",
      "cong",
      "ruc",
      "ro",
      "that",
      "nha",
      "nhe",
      "em",
      "be"
    ]);

    const picked = [];

    for (const word of words) {
      const lower = cleanText(word).toLowerCase();

      if (stopWords.has(lower)) break;
      if (/^\d+$/.test(lower)) break;

      picked.push(word);

      if (picked.length >= 3) break;
    }

    if (picked.length > 0) {
      return normalizeName(picked.join(" "));
    }

    return normalizeName(`${fallbackChannel} - ${cleaned.slice(0, 60)}`);
  }

  function getName(txn) {
    const title =
      txn.txnTitle ||
      txn.counterpartName ||
      txn.senderName ||
      txn.fullName ||
      txn.name ||
      "";

    const desc =
      txn.txnDesc ||
      txn.description ||
      txn.memo ||
      txn.content ||
      txn.remark ||
      "";

    const normalizedTitle = normalizeName(title);

    if (isGenericPaymentTitle(title)) {
      let channel = "DONOR";

      if (normalizedTitle.includes("MOMO")) {
        channel = "MOMO";
      } else if (
        normalizedTitle.includes("MBBANK") ||
        normalizedTitle.includes("MB BANK")
      ) {
        channel = "MBBANK";
      } else if (normalizedTitle.includes("ZION")) {
        channel = "ZALOPAY";
      } else if (normalizedTitle.includes("SHOPEEPAY")) {
        channel = "SHOPEEPAY";
      }

      return inferNameFromDesc(desc, channel);
    }

    return normalizeName(title || "Ẩn danh");
  }

  function isOnOrAfterStartDate(txn) {
    if (!txn._groupDate) return false;

    const start = new Date(TOP_DONOR_FROM_DATE + "T00:00:00+07:00");

    return txn._groupDate.getTime() >= start.getTime();
  }

  async function fetchPage(xidIndex) {
    const payload = {
      size: PAGE_SIZE,
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
      nextXidIndex:
        Number(json?.data?.lastIndex || json?.lastIndex || 0) || null
    };
  }

  try {
    const allTxns = [];
    const seen = new Set();

    let xidIndex = 0;

    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const page = await fetchPage(xidIndex);
      const txns = page.txns;

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

      if (!page.nextXidIndex || page.nextXidIndex === xidIndex) {
        break;
      }

      xidIndex = page.nextXidIndex;
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
    const top3NameSet = new Set(top3.map((d) => d.name));
    const nonTop3Donors = donors.filter((d) => !top3NameSet.has(d.name));

    const over3m = nonTop3Donors.filter((d) => d.amount >= 3000000);

    const over2m = nonTop3Donors.filter(
      (d) => d.amount >= 2000000 && d.amount < 3000000
    );

    const over500k = nonTop3Donors.filter(
      (d) => d.amount >= 500000 && d.amount < 2000000
    );

    const payload = {
      success: true,

      top3,
      over3m,
      over2m,
      over500k,

      over5m: over3m,

      donorCount: donors.length,

      debug: {
        rawTxnCount: allTxns.length,
        validTxnCount: validTxns.length,
        totalDonorCount: donors.length,
        top3Count: top3.length,
        over3mCount: over3m.length,
        over2mCount: over2m.length,
        over500kCount: over500k.length,
        fromDate: TOP_DONOR_FROM_DATE,
        pageSize: PAGE_SIZE,
        maxPages: MAX_PAGES,
        paginationMode: "lastIndex",
        bucketMode: "exclusive",
        donorNameMode: "strip-tu-and-infer-from-description",
        cacheMode: "memory",
        cacheTtlMs: TOP_DONORS_CACHE_TTL
      }
    };

    TOP_DONORS_CACHE = payload;
    TOP_DONORS_CACHE_TIME = Date.now();

    return res.status(200).json({
      ...payload,
      cached: false,
      cacheAgeMs: 0
    });
  } catch (error) {
    console.error("Top donors API error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

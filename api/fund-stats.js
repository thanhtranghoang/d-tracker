module.exports = async (req, res) => {
    // 1. Cấu hình CORS và Cache cho Vercel
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const TIMO_VERIFY_CODE = '1iyeys6er88q9';
    const TARGET_AMOUNT = 270000000; // 270 Triệu

    // 2. Bộ ngụy trang trình duyệt (Fake Headers)
    const fakeHeaders = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://share.timo.vn',
        'Referer': 'https://share.timo.vn/'
    };

    try {
        // 3. Lấy Hash Code (DÙNG SHARE.TIMO.VN)
        const aliasRes = await fetch('https://share.timo.vn/api/sync/alias', {
            method: 'POST',
            headers: fakeHeaders,
            body: JSON.stringify({ verifyCode: TIMO_VERIFY_CODE })
        });
        
        if (!aliasRes.ok) throw new Error(`Timo chặn kết nối Alias (Mã lỗi: ${aliasRes.status})`);
        
        const aliasData = await aliasRes.json();
        const hash = aliasData.hashVerifyCode || aliasData.data?.hashVerifyCode;

        if (!hash) throw new Error('Không lấy được mã xác thực quỹ từ Timo');

        // 4. Lấy Lịch sử giao dịch (DÙNG SHARE.TIMO.VN)
        const txnRes = await fetch('https://share.timo.vn/api/sync/txn', {
            method: 'POST',
            headers: fakeHeaders,
            body: JSON.stringify({
                verifyCode: TIMO_VERIFY_CODE,
                hashVerifyCode: hash,
                size: 1000 // Lấy 1000 giao dịch gần nhất
            })
        });

        if (!txnRes.ok) throw new Error(`Timo chặn kết nối Lịch sử (Mã lỗi: ${txnRes.status})`);

        const txnData = await txnRes.json();
        const rawTxns = txnData.transactions || txnData.txnHistories || txnData.data?.txnHistories || [];

        // 5. Xử lý và tính toán dữ liệu
        let totalAmount = 0;
        const donorMap = {};
        const amounts = [];
        
        // Lọc các giao dịch cộng tiền (số tiền > 0)
        const incomingTxns = rawTxns.filter(t => parseFloat(t.amount || t.txnAmount || 0) > 0);

        const transactions = incomingTxns.map(t => {
            const amt = parseFloat(t.amount || t.txnAmount || 0);
            totalAmount += amt;
            amounts.push(amt);
            
            let nameForTop = t.counterpartName || t.senderName || t.fullName || 'Ẩn danh';
            nameForTop = nameForTop.trim().toUpperCase();
            donorMap[nameForTop] = (donorMap[nameForTop] || 0) + amt;

            return {
                name: t.counterpartName || t.senderName || t.fullName || 'Ẩn danh',
                desc: t.description || t.memo || '',
                amount: amt,
                time: t.txnDate || t.createdAt || t.date || null
            };
        });

        // Xếp hạng Top 10
        const topDonors = Object.entries(donorMap)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, amount], i) => ({ rank: i + 1, name, amount }));

        const avgAmount = incomingTxns.length ? totalAmount / incomingTxns.length : 0;
        const maxAmount = amounts.length ? Math.max(...amounts) : 0;

        // 6. Trả kết quả về cho Website
        res.status(200).json({
            success: true,
            totalAmount: totalAmount,
            targetAmount: TARGET_AMOUNT,
            transactions: transactions.slice(0, 50),
            topDonors: topDonors,
            txnCount: incomingTxns.length,
            avgAmount: avgAmount,
            maxAmount: maxAmount
        });

    } catch (error) {
        console.error("Lỗi API Vercel:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

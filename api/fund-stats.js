module.exports = async (req, res) => {
    // 1. Cấu hình CORS và Cache cho Vercel (Tối ưu tốc độ tải siêu nhanh)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // --- CẤU HÌNH MÃ QUỸ CỦA BẠN ---
    const TIMO_VERIFY_CODE = '1iyeys6er88q9';
    const TARGET_AMOUNT = 270000000; // 270 Triệu VNĐ

    try {
        // 2. Lấy Hash Code xác thực từ API của Timo
        const aliasRes = await fetch('https://app.timo.vn/api/sync/alias', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ verifyCode: TIMO_VERIFY_CODE })
        });
        const aliasData = await aliasRes.json();
        const hash = aliasData.hashVerifyCode || aliasData.data?.hashVerifyCode;

        if (!hash) {
            throw new Error('Không thể lấy mã xác thực từ Timo. Vui lòng kiểm tra lại mã quỹ.');
        }

        // 3. Lấy Lịch sử giao dịch (Lấy 1000 GD gần nhất)
        const txnRes = await fetch('https://app.timo.vn/api/sync/txn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                verifyCode: TIMO_VERIFY_CODE,
                hashVerifyCode: hash,
                size: 1000
            })
        });

        const txnData = await txnRes.json();
        const rawTxns = txnData.transactions || txnData.txnHistories || txnData.data?.txnHistories || [];

        // 4. Xử lý logic Backend
        let totalAmount = 0;
        const donorMap = {};
        const amounts = [];
        
        // Lọc: Chỉ lấy các giao dịch CỘNG TIỀN
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

        // Xếp hạng Top 10 Donors
        const topDonors = Object.entries(donorMap)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, amount], i) => ({ rank: i + 1, name, amount }));

        // Tính các chỉ số thống kê
        const avgAmount = incomingTxns.length ? totalAmount / incomingTxns.length : 0;
        const maxAmount = amounts.length ? Math.max(...amounts) : 0;

        // 5. Trả về cấu trúc JSON chuẩn cho Frontend
        res.status(200).json({
            success: true,
            totalAmount: totalAmount,
            targetAmount: TARGET_AMOUNT,
            transactions: transactions.slice(0, 50), // Chỉ gửi 50 giao dịch mới nhất để web nhẹ
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

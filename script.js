// Chạy khi trang được tải lần đầu để hiển thị lịch sử
document.addEventListener('DOMContentLoaded', () => {
    updateUploadHistoryList();
});

/**
 * HÀM TIỆN ÍCH
 * Chuyển chuỗi "DD/MM/YYYY" thành "YYYY-MM-DD" để dễ so sánh và lưu trữ
 */
function parseDateToISO(dateString) {
    const parts = dateString.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!parts) return null;
    return `${parts[3]}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
}

/**
 * TRÍCH XUẤT DỮ LIỆU VÀ NGÀY THÁNG TỪ PDF
 */
async function extractDataFromPdf(file) {
    const fileReader = new FileReader();
    
    return new Promise((resolve, reject) => {
        fileReader.onload = async function() {
            try {
                const typedarray = new Uint8Array(this.result);
                const pdf = await pdfjsLib.getDocument(typedarray).promise;
                const page = await pdf.getPage(1);
                const textContent = await page.getTextContent();
                const items = textContent.items;

                let invoiceDate = null;
                const dateLabelItem = items.find(item => item.str.trim().toLowerCase() === 'date:');
                if (dateLabelItem) {
                    const dateRegex = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
                    const potentialDateItems = items.filter(item => dateRegex.test(item.str));
                    if (potentialDateItems.length > 0) {
                        potentialDateItems.sort((a, b) => {
                            const distA = Math.hypot(a.transform[4] - dateLabelItem.transform[4], a.transform[5] - dateLabelItem.transform[5]);
                            const distB = Math.hypot(b.transform[4] - dateLabelItem.transform[4], b.transform[5] - dateLabelItem.transform[5]);
                            return distA - distB;
                        });
                        const closestDateItem = potentialDateItems[0];
                        invoiceDate = parseDateToISO(closestDateItem.str.trim());
                    }
                }
                
                if (!invoiceDate) {
                    return reject("Không thể tìm thấy hoặc đọc được ngày tháng trên hóa đơn. Vui lòng kiểm tra định dạng file PDF.");
                }

                let codeX = null, descriptionX = null, qtyX = null;
                const headerItem = items.find(item => "code" === item.str.trim().toLowerCase());
                if (!headerItem) return reject("Không tìm thấy header 'Code' trong bảng.");
                const headerY = headerItem.transform[5];
                items.forEach((item => { if (Math.abs(item.transform[5] - headerY) < 2) { const str = item.str.trim().toLowerCase(); "code" === str && (codeX = item.transform[4]), "description" === str && (descriptionX = item.transform[4]), "qty" === str && (qtyX = item.transform[4]) } }));
                if (null === codeX || null === descriptionX || null === qtyX) return reject("Không thể xác định vị trí các cột 'Code', 'Description', hoặc 'Qty'.");
                const rows = {}; const tolerance = 5;
                items.forEach((item => { if (!(item.transform[5] >= headerY || "" === item.str.trim() || item.str.trim().toLowerCase().startsWith("total"))) { const y = item.transform[5]; let foundRowKey = Object.keys(rows).find((key => Math.abs(key - y) < tolerance)); foundRowKey ? rows[foundRowKey].push(item) : rows[y] = [item] } }));
                const extractedItems = [];
                for (const y in rows) { const rowItems = rows[y].sort(((a, b) => a.transform[4] - b.transform[4])); const codeItem = rowItems.find((item => Math.abs(item.transform[4] - codeX) < 10)); const qtyItem = rowItems.find((item => Math.abs(item.transform[4] - qtyX) < 10)); const description = rowItems.filter((item => item.transform[4] >= descriptionX && item.transform[4] < qtyX)).map((d => d.str)).join(" ").trim(); codeItem && qtyItem && !isNaN(parseInt(qtyItem.str.trim(), 10)) && extractedItems.push({ ma_san_pham: codeItem.str.trim(), mo_ta: description, so_luong: parseInt(qtyItem.str.trim(), 10) }) }
                const aggregatedSales = {};
                extractedItems.forEach((item => { aggregatedSales[item.ma_san_pham] ? aggregatedSales[item.ma_san_pham].so_luong += item.so_luong : aggregatedSales[item.ma_san_pham] = { so_luong: item.so_luong, mo_ta: item.mo_ta } }));
                const salesData = Object.keys(aggregatedSales).map((code => ({ ma_san_pham: code, mo_ta: aggregatedSales[code].mo_ta, so_luong: aggregatedSales[code].so_luong })));
                
                resolve({ invoiceDate, salesData });

            } catch (error) {
                reject("Lỗi khi xử lý file PDF: " + error);
            }
        };
        fileReader.readAsArrayBuffer(file);
    });
}

/**
 * LƯU TRỮ DỮ LIỆU
 */
function getSalesHistory() {
    const history = localStorage.getItem('salesHistory');
    return history ? JSON.parse(history).sort((a, b) => new Date(b.date) - new Date(a.date)) : [];
}

function saveSalesHistory(invoiceDate, salesData) {
    let history = getSalesHistory();
    const filteredHistory = history.filter(entry => entry.date !== invoiceDate);
    filteredHistory.push({ date: invoiceDate, sales: salesData });
    const sortedHistory = filteredHistory.sort((a, b) => new Date(b.date) - new Date(a.date));
    localStorage.setItem('salesHistory', JSON.stringify(sortedHistory.slice(0, 90)));
}

/**
 * CÁC HÀM TÌM KIẾM DỮ LIỆU CHÍNH XÁC
 */
function findPreviousOrder(currentDate, history) {
    return history.find(entry => new Date(entry.date) < new Date(currentDate)) || null;
}

function findSameDayLastWeekOrder(currentDate, history) {
    const targetDate = new Date(currentDate);
    targetDate.setDate(targetDate.getDate() - 7);
    const targetDateString = targetDate.toISOString().split('T')[0];
    return history.find(entry => entry.date === targetDateString) || null;
}

/**
 * HIỂN THỊ KẾT QUẢ SO SÁNH
 */
function displayComparison(todayData, prevData, tableId, titleId, titlePrefix, swapQtyColumns = false) {
    const tableBody = document.querySelector(`#${tableId} tbody`);
    const titleElement = document.getElementById(titleId);
    tableBody.innerHTML = '';
    const todayDateStr = new Date(todayData.invoiceDate).toLocaleDateString('vi-VN');

    if (!prevData) {
        titleElement.textContent = `${titlePrefix} (Hôm nay: ${todayDateStr})`;
        tableBody.innerHTML = `<tr><td colspan="6">Không tìm thấy dữ liệu để so sánh.</td></tr>`;
        return;
    }

    const prevDateStr = new Date(prevData.date).toLocaleDateString('vi-VN');
    titleElement.textContent = `${titlePrefix} (So sánh ngày ${todayDateStr} với ngày ${prevDateStr})`;

    const prevSalesMap = new Map(prevData.sales.map(item => [item.ma_san_pham, item]));
    const todaySalesMap = new Map(todayData.salesData.map(item => [item.ma_san_pham, item]));
    const allProductCodes = new Set([...todaySalesMap.keys(), ...prevSalesMap.keys()]);
    const comparisonData = [];

    allProductCodes.forEach(code => {
        const todayItem = todaySalesMap.get(code);
        const prevItem = prevSalesMap.get(code);
        const qtyToday = todayItem ? todayItem.so_luong : 0;
        const qtyPrev = prevItem ? prevItem.so_luong : 0;
        const difference = qtyToday - qtyPrev;
        
        if (difference === 0) return;

        let conclusion = '';
        if (qtyToday > 0 && qtyPrev > 0) {
            conclusion = difference > 0 ? `Tăng ${difference}` : `Giảm ${Math.abs(difference)}`;
        } else if (qtyToday > 0 && qtyPrev === 0) {
            conclusion = 'Mới xuất hiện';
        } else if (qtyToday === 0 && qtyPrev > 0) {
            conclusion = 'Không đặt lần này';
        }

        comparisonData.push({
            ma_san_pham: code,
            mo_ta: todayItem ? todayItem.mo_ta : prevItem.mo_ta,
            so_luong: qtyToday,
            so_luong_truoc: qtyPrev,
            chenh_lech: difference,
            ket_luan: conclusion
        });
    });

    comparisonData.sort((a, b) => Math.abs(b.chenh_lech) - Math.abs(a.chenh_lech));

    comparisonData.forEach(item => {
        let rowClass = '';
        if (item.chenh_lech > 0) rowClass = 'row-increase';
        if (item.chenh_lech < 0) rowClass = item.so_luong > 0 ? 'row-decrease' : 'row-removed';
        if (item.ket_luan === 'Mới xuất hiện') rowClass = 'row-new';
        
        const qtyCellsHTML = swapQtyColumns
            ? `<td>${item.so_luong_truoc}</td><td>${item.so_luong}</td>`
            : `<td>${item.so_luong}</td><td>${item.so_luong_truoc}</td>`;

        const row = `<tr class="${rowClass}">
            <td>${item.ma_san_pham}</td><td>${item.mo_ta}</td>
            ${qtyCellsHTML}
            <td>${item.chenh_lech > 0 ? '+' : ''}${item.chenh_lech}</td><td>${item.ket_luan}</td>
        </tr>`;
        tableBody.innerHTML += row;
    });
}

function updateUploadHistoryList() {
    const history = getSalesHistory();
    const listElement = document.getElementById('history-list');
    listElement.innerHTML = '';
    if (history.length === 0) { listElement.innerHTML = '<li>Chưa có dữ liệu</li>'; return; }
    history.forEach(entry => {
        const date = new Date(entry.date);
        const formattedDate = date.toLocaleDateString('vi-VN');
        const listItem = document.createElement('li');
        listItem.textContent = formattedDate;
        listElement.appendChild(listItem);
    });
}

// --- LUỒNG CHẠY CHÍNH KHI NHẤN NÚT "PHÂN TÍCH" ---
document.getElementById('analyze-button').addEventListener('click', async () => {
    const fileInput = document.getElementById('pdf-file');
    const statusDiv = document.getElementById('status');
    statusDiv.className = '';
    
    if (fileInput.files.length === 0) {
        alert('Vui lòng chọn một file PDF!');
        return;
    }

    statusDiv.textContent = 'Đang đọc và phân tích file PDF...';
    try {
        const { invoiceDate, salesData } = await extractDataFromPdf(fileInput.files[0]);
        const todayData = { invoiceDate, salesData };
        statusDiv.textContent = `Đã đọc hóa đơn ngày ${new Date(invoiceDate).toLocaleDateString('vi-VN')}. Bắt đầu so sánh...`;
        
        const history = getSalesHistory();
        const prevOrder = findPreviousOrder(invoiceDate, history);
        const lastWeekOrder = findSameDayLastWeekOrder(invoiceDate, history);
        
        // Cả hai bảng bây giờ đều hoán đổi cột
        displayComparison(todayData, prevOrder, 'comparison-last-order-table', 'last-order-title', 'So sánh với Đơn hàng Gần Nhất', true); // <-- THAY ĐỔI Ở ĐÂY: TỪ FALSE THÀNH TRUE
        displayComparison(todayData, lastWeekOrder, 'comparison-last-week-table', 'last-week-title', 'So sánh với Cùng Ngày Tuần Trước', true);
        
        saveSalesHistory(invoiceDate, salesData);
        updateUploadHistoryList();
        
        statusDiv.textContent = 'Phân tích hoàn tất! Dữ liệu đã được lưu lại.';

    } catch (error) {
        statusDiv.textContent = `Lỗi: ${error}`;
        statusDiv.className = 'error-message';
    }
});
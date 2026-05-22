const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const bodyParser = require('body-parser');

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Store pending transactions (in production, use a database)
let pendingTransactions = new Map();

// M-Pesa API URLs
const API_URLS = {
    sandbox: 'https://sandbox.safaricom.co.ke',
    production: 'https://api.safaricom.co.ke'
};

// Helper: Get Access Token
async function getAccessToken() {
    const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');
    const url = `${API_URLS[process.env.ENVIRONMENT || 'sandbox']}/oauth/v1/generate?grant_type=client_credentials`;
    
    try {
        const response = await axios.get(url, {
            headers: { Authorization: `Basic ${auth}` }
        });
        return response.data.access_token;
    } catch (error) {
        console.error('Error getting access token:', error.response?.data || error.message);
        throw error;
    }
}

// Helper: Generate Password
function generatePassword() {
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(
        `${process.env.SHORTCODE}${process.env.PASSKEY}${timestamp}`
    ).toString('base64');
    return { timestamp, password };
}

// Format phone number for M-Pesa (254XXXXXXXXX)
function formatPhoneNumber(phone) {
    let cleaned = phone.toString().replace(/\s/g, '');
    if (cleaned.startsWith('0')) {
        cleaned = '254' + cleaned.substring(1);
    } else if (cleaned.startsWith('+254')) {
        cleaned = cleaned.substring(1);
    } else if (!cleaned.startsWith('254')) {
        cleaned = '254' + cleaned;
    }
    return cleaned;
}

// ============ STK Push Endpoint ============
app.post('/api/mpesa/stkpush', async (req, res) => {
    const { phoneNumber, amount, accountReference, transactionDesc, requestId } = req.body;
    
    if (!phoneNumber || !amount) {
        return res.status(400).json({ 
            success: false, 
            message: 'Phone number and amount are required' 
        });
    }
    
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    try {
        const token = await getAccessToken();
        const { timestamp, password } = generatePassword();
        
        const payload = {
            BusinessShortCode: process.env.SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: Math.round(amount),
            PartyA: formattedPhone,
            PartyB: process.env.SHORTCODE,
            PhoneNumber: formattedPhone,
            CallBackURL: process.env.CALLBACK_URL,
            AccountReference: accountReference || `REAGAN${Date.now()}`,
            TransactionDesc: transactionDesc || 'Payment for IT Services'
        };
        
        console.log('Sending STK Push to:', formattedPhone);
        
        const response = await axios.post(
            `${API_URLS[process.env.ENVIRONMENT || 'sandbox']}/mpesa/stkpush/v1/processrequest`,
            payload,
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        
        // Store transaction for callback
        if (response.data.CheckoutRequestID) {
            pendingTransactions.set(response.data.CheckoutRequestID, {
                requestId,
                phoneNumber: formattedPhone,
                amount,
                status: 'pending',
                timestamp: new Date().toISOString()
            });
        }
        
        res.json({
            success: true,
            message: 'STK Push sent successfully',
            data: response.data
        });
        
    } catch (error) {
        console.error('STK Push Error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to send STK Push',
            error: error.response?.data || error.message
        });
    }
});

// ============ Callback Endpoint ============
app.post('/api/mpesa/callback', async (req, res) => {
    console.log('M-Pesa Callback received');
    
    const stkCallback = req.body?.Body?.stkCallback;
    
    if (!stkCallback) {
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
    
    const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = stkCallback;
    const pendingTransaction = pendingTransactions.get(CheckoutRequestID);
    
    if (ResultCode === 0) {
        // Payment successful
        let amount = 0;
        let mpesaReceipt = '';
        
        if (CallbackMetadata?.Item) {
            for (const item of CallbackMetadata.Item) {
                if (item.Name === 'Amount') amount = item.Value;
                if (item.Name === 'MpesaReceiptNumber') mpesaReceipt = item.Value;
            }
        }
        
        console.log(`✅ Payment successful! Receipt: ${mpesaReceipt}, Amount: ${amount}`);
        
        pendingTransactions.set(CheckoutRequestID, {
            ...pendingTransaction,
            status: 'completed',
            amount,
            mpesaReceipt,
            transactionDate: new Date().toISOString()
        });
    } else {
        console.log(`❌ Payment failed: ${ResultDesc}`);
        pendingTransactions.set(CheckoutRequestID, {
            ...pendingTransaction,
            status: 'failed',
            errorCode: ResultCode,
            errorMessage: ResultDesc
        });
    }
    
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ============ Check Transaction Status ============
app.get('/api/mpesa/status/:checkoutRequestId', async (req, res) => {
    const { checkoutRequestId } = req.params;
    const transaction = pendingTransactions.get(checkoutRequestId);
    
    if (transaction) {
        res.json({ success: true, status: transaction.status, transaction });
    } else {
        res.json({ success: false, status: 'not_found' });
    }
});

// ============ Health Check ============
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ M-Pesa Server running on port ${PORT}`);
    console.log(`📡 Environment: ${process.env.ENVIRONMENT || 'sandbox'}`);
    console.log(`📞 Shortcode: ${process.env.SHORTCODE}`);
});
require('dotenv').config(); // সবার আগে থাকতে হবে
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const firebaseAdmin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Firebase Admin initialization logic
const adminCredentials = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
};

firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(adminCredentials),
});

// Middlewares
app.use(cors());
app.use(express.json());

// MongoDB connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

async function run() {
    try {
        const db = client.db("assignment-11");
        const usersCol = db.collection("users");
        const lessonsCol = db.collection("lessons");
        const reportsCol = db.collection("reports");

        // --- Auth: JWT Generation ---
        app.post('/jwt', async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '5h' });
            res.send({ token });
        });

        // Middleware to verify Token
        const verifyUser = (req, res, next) => {
            if (!req.headers.authorization) return res.status(401).send({ message: 'Unauthorized' });
            const token = req.headers.authorization.split(' ')[1];
            jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
                if (err) return res.status(403).send({ message: 'Forbidden' });
                req.decoded = decoded;
                next();
            });
        };

        // --- Lessons: Get, Post & Search ---
        app.get('/all-lessons', async (req, res) => {
            const { search, category, tone, page = 1, limit = 8 } = req.query;
            const skip = (parseInt(page) - 1) * parseInt(limit);
            
            // রিকোয়ারমেন্ট অনুযায়ী শুধুমাত্র Public লেসন দেখাবে
            let query = { visibility: 'Public' };

            if (search) query.title = { $regex: search, $options: 'i' };
            if (category) query.category = category;
            if (tone) query.emotionalTone = tone;

            const totalCount = await lessonsCol.countDocuments(query);
            const data = await lessonsCol.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .toArray();

            res.send({ data, totalCount });
        });

        app.post('/add-lesson', verifyUser, async (req, res) => {
            const lessonData = { ...req.body, createdAt: new Date() };
            const result = await lessonsCol.insertOne(lessonData);
            res.send(result);
        });

        // --- Payment: Stripe Intent ---
        app.post('/create-payment-intent', verifyUser, async (req, res) => {
            const { price } = req.body;
            const amount = parseInt(price * 100); // সেন্টে কনভার্ট করা

            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: 'bdt',
                payment_method_types: ['card'],
            });

            res.send({ clientSecret: paymentIntent.client_secret });
        });

        // Update User to Premium after Payment
        app.patch('/users/make-premium/:email', verifyUser, async (req, res) => {
            const email = req.params.email;
            const update = { $set: { isPremium: true, premiumSince: new Date() } };
            const result = await usersCol.updateOne({ email }, update);
            res.send(result);
        });

        // --- User API: Save/Update User ---
        app.put('/save-user', async (req, res) => {
            const user = req.body;
            const result = await usersCol.updateOne(
                { email: user.email },
                { $set: user },
                { upsert: true }
            );
            res.send(result);
        });

        console.log("✅ Server and MongoDB are connected successfully!");
    } finally { }
}
run().catch(console.dir);

app.get('/', (req, res) => res.send('Digital Life Lessons Server is Active'));
app.listen(port, () => console.log(`🚀 Listening on port ${port}`));
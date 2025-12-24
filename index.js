require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const firebaseAdmin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

// --- Firebase Admin SDK Setup ---
const serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(serviceAccount),
});

// --- Middlewares ---
app.use(cors());
app.use(express.json());

// --- MongoDB Connection ---
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

async function run() {
    try {
        const db = client.db("assignment-11"); // ডাটাবেস নাম
        const usersCol = db.collection("users");
        const lessonsCol = db.collection("lessons");
        const reportsCol = db.collection("reports");
        const favoritesCol = db.collection("favorites");
        const paymentsCol = db.collection("payments"); // পেমেন্ট হিস্ট্রির জন্য নতুন কালেকশন

        // --- Custom Middlewares ---

        // 1. Verify Token (Firebase Admin SDK)
        const verifyToken = async (req, res, next) => {
            if (!req.headers.authorization) {
                return res.status(401).send({ message: 'Unauthorized access' });
            }
            const token = req.headers.authorization.split(' ')[1];
            try {
                const decodedToken = await firebaseAdmin.auth().verifyIdToken(token);
                req.user = decodedToken;
                next();
            } catch (error) {
                console.error("Token Error:", error);
                return res.status(403).send({ message: 'Forbidden access' });
            }
        };

        // 2. Verify Admin
        const verifyAdmin = async (req, res, next) => {
            const email = req.user.email;
            const query = { email: email };
            const user = await usersCol.findOne(query);
            const isAdmin = user?.role === 'admin';
            if (!isAdmin) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            next();
        };


        // --- User Related APIs ---

        // Save or Update User
        app.post('/users', async (req, res) => {
            const user = req.body;
            const query = { email: user.email };
            const existingUser = await usersCol.findOne(query);
            if (existingUser) {
                return res.send({ message: 'User already exists', insertedId: null });
            }
            const result = await usersCol.insertOne({ ...user, role: 'user', isPremium: false });
            res.send(result);
        });

        // Check if user is Admin
        app.get('/users/admin/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.user.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            const query = { email: email };
            const user = await usersCol.findOne(query);
            let admin = false;
            if (user) {
                admin = user?.role === 'admin';
            }
            res.send({ admin });
        });
        
        // Get User Role & Premium Status (For Hook)
        app.get('/users/role/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.user.email) return res.status(403).send({ message: 'forbidden' });
            const user = await usersCol.findOne({ email });
            res.send({ role: user?.role, isPremium: user?.isPremium });
        });


        // --- Payment APIs (Stripe) ---

        app.post('/create-payment-intent', verifyToken, async (req, res) => {
            const { price } = req.body;
            const amount = parseInt(price * 100);

            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: 'usd', // Stripe Test Mode এ সাধারণত USD তে ভালো কাজ করে, BDT তে সমস্যা হতে পারে যদি সেটআপ না থাকে। আপনি চাইলে 'bdt' রাখতে পারেন।
                payment_method_types: ['card'],
            });

            res.send({ clientSecret: paymentIntent.client_secret });
        });

        // Save Payment Info & Make User Premium
        app.post('/payments', verifyToken, async (req, res) => {
            const payment = req.body;
            const paymentResult = await paymentsCol.insertOne(payment);
            
            // ইউজারের স্ট্যাটাস আপডেট
            const query = { email: payment.email };
            const updatedDoc = {
                $set: { isPremium: true, premiumSince: new Date() }
            };
            const updateResult = await usersCol.updateOne(query, updatedDoc);

            res.send({ paymentResult, updateResult });
        });


        // --- Lesson APIs ---

        // Get All Lessons (Search + Filter + Sort + Pagination)
        app.get('/all-lessons', async (req, res) => {
            const { search, category, tone, sort, page = 1, limit = 8 } = req.query;
            const skip = (parseInt(page) - 1) * parseInt(limit);

            let query = { visibility: 'Public' };

            if (search) query.title = { $regex: search, $options: 'i' };
            if (category) query.category = category;
            if (tone) query.emotionalTone = tone;

            let sortOptions = { createdAt: -1 };
            if (sort === 'oldest') {
                sortOptions = { createdAt: 1 };
            } else if (sort === 'most-saved') {
                sortOptions = { likesCount: -1 };
            }

            const totalCount = await lessonsCol.countDocuments(query);
            const data = await lessonsCol.find(query)
                .sort(sortOptions)
                .skip(skip)
                .limit(parseInt(limit))
                .toArray();

            res.send({ data, totalCount });
        });

        // Create Lesson
        app.post('/add-lesson', verifyToken, async (req, res) => {
            const lessonData = {
                ...req.body,
                likesCount: 0,
                createdAt: new Date(),
                authorEmail: req.user.email
            };
            const result = await lessonsCol.insertOne(lessonData);
            res.send(result);
        });

        // Get Single Lesson
        app.get('/lessons/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await lessonsCol.findOne(query);
            res.send(result);
        });

        // Get My Lessons
        app.get('/my-lessons/:email', verifyToken, async (req, res) => {
            if (req.params.email !== req.user.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            const query = { authorEmail: req.params.email };
            const result = await lessonsCol.find(query).toArray();
            res.send(result);
        });

        // Update Lesson
        app.put('/update-lesson/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updatedDoc = { $set: req.body };
            const result = await lessonsCol.updateOne(filter, updatedDoc);
            res.send(result);
        });

        // Delete Lesson
        app.delete('/delete-lesson/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await lessonsCol.deleteOne(query);
            res.send(result);
        });


        // --- Engagement APIs (Fixed Logic) ---

        // Like/Unlike Toggle Logic (UPDATED)
        app.patch('/lessons/like/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const userEmail = req.user.email;
            const filter = { _id: new ObjectId(id) };
            
            const lesson = await lessonsCol.findOne(filter);
            const isLiked = lesson.likes?.includes(userEmail); // likes অ্যারে থাকতে হবে

            let updateDoc;
            if (isLiked) {
                updateDoc = {
                    $pull: { likes: userEmail },
                    $inc: { likesCount: -1 }
                };
            } else {
                updateDoc = {
                    $addToSet: { likes: userEmail },
                    $inc: { likesCount: 1 }
                };
            }
            const result = await lessonsCol.updateOne(filter, updateDoc);
            res.send(result);
        });

        // Report Lesson
        app.post('/reports', verifyToken, async (req, res) => {
            const reportData = { ...req.body, reportedAt: new Date(), reporterEmail: req.user.email };
            const result = await reportsCol.insertOne(reportData);
            res.send(result);
        });

        // Add to Favorites
        app.post('/favorites', verifyToken, async (req, res) => {
            const favData = req.body;
            const existing = await favoritesCol.findOne({ lessonId: favData.lessonId, userEmail: req.user.email });
            if (existing) return res.send({ message: 'Already in favorites' });

            const result = await favoritesCol.insertOne(favData);
            res.send(result);
        });

        // Get My Favorites
        app.get('/favorites/:email', verifyToken, async (req, res) => {
            if (req.params.email !== req.user.email) return res.status(403).send({ message: 'forbidden' });
            const result = await favoritesCol.find({ userEmail: req.params.email }).toArray();
            res.send(result);
        });


        // --- Admin Dashboard APIs ---

        // Manage Users
        app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
            const result = await usersCol.find().toArray();
            res.send(result);
        });

        // Make Admin
        app.patch('/users/admin/:id', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = { $set: { role: 'admin' } };
            const result = await usersCol.updateOne(filter, updateDoc);
            res.send(result);
        });
        
        // Get All Reports (UPDATED)
        app.get('/reports', verifyToken, verifyAdmin, async (req, res) => {
            const result = await reportsCol.find().toArray();
            res.send(result);
        });

        // Delete Report (UPDATED)
        app.delete('/reports/:id', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await reportsCol.deleteOne(query);
            res.send(result);
        });

        // Admin Stats
        app.get('/admin-stats', verifyToken, verifyAdmin, async (req, res) => {
            const users = await usersCol.estimatedDocumentCount();
            const lessons = await lessonsCol.estimatedDocumentCount();
            const reports = await reportsCol.estimatedDocumentCount();
            res.send({ users, lessons, reports });
        });


        console.log("✅ Digital Life Lessons Server Running");
    } finally {
        // await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Digital Life Lessons Server is Active');
});

app.listen(port, () => {
    console.log(`🚀 Listening on port ${port}`);
});
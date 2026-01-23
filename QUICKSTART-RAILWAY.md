# 🚀 Quick Start - Deploy to Railway in 5 Minutes

## What You'll Need
- GitHub account
- Railway account (free)
- Your Anthropic API key

---

## Step 1: Push to GitHub (2 minutes)

Open terminal in this folder and run:

```bash
git init
git add .
git commit -m "HCD Listing Generator"
```

Then create a new **private** repository on GitHub and push:

```bash
git remote add origin https://github.com/YOUR-USERNAME/hcd-listing-generator.git
git branch -M main
git push -u origin main
```

---

## Step 2: Deploy on Railway (3 minutes)

1. **Go to [railway.app](https://railway.app)** and login with GitHub

2. **Click "New Project"** → "Deploy from GitHub repo"

3. **Select** your `hcd-listing-generator` repository

4. **Add Environment Variables:**
   - Click on your service
   - Go to "Variables" tab
   - Click "New Variable"
   - Add:
     - `ANTHROPIC_API_KEY` = `your-api-key-here`
     - `PORT` = `3000`

5. **Generate Domain:**
   - Go to "Settings" tab
   - Click "Generate Domain"
   - Copy your URL (e.g., `hcd-listing-generator.up.railway.app`)

6. **Wait 2-3 minutes** for deployment to complete

---

## Step 3: Test It!

Visit your Railway URL and:
1. Click "📋 Load Example"
2. Click "✨ Generate"
3. Wait for results!

---

## 🎉 You're Done!

Share the Railway URL with your team. They can access it from any browser, no installation needed!

### To Update Later:
```bash
git add .
git commit -m "Updated features"
git push
```
Railway will auto-redeploy!

---

### ⚠️ Important Security
- Keep your GitHub repo **Private**
- Don't share your Railway URL publicly
- Monitor API usage on Railway dashboard

### 💰 Costs
- Railway: $5/month free credit
- Claude API: ~$0.01-0.02 per listing

For detailed instructions, see [DEPLOYMENT.md](DEPLOYMENT.md)

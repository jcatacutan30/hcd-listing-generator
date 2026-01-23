# Railway Deployment Guide

## Quick Deploy to Railway

### Step 1: Prerequisites
- GitHub account (free)
- Railway account (free - sign up at [railway.app](https://railway.app))
- Your Anthropic API key

### Step 2: Push to GitHub

1. **Initialize Git** (if not already done):
   ```bash
   git init
   git add .
   git commit -m "Initial commit - HCD Listing Generator"
   ```

2. **Create GitHub Repository**:
   - Go to [github.com](https://github.com) and create a new repository
   - Name it: `hcd-listing-generator`
   - Keep it **Private** (recommended for security)
   - Don't initialize with README (we already have files)

3. **Push to GitHub**:
   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/hcd-listing-generator.git
   git branch -M main
   git push -u origin main
   ```

### Step 3: Deploy on Railway

1. **Sign up/Login to Railway**:
   - Go to [railway.app](https://railway.app)
   - Click "Login with GitHub"

2. **Create New Project**:
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose your `hcd-listing-generator` repository

3. **Configure Environment Variables**:
   - Once deployed, click on your service
   - Go to "Variables" tab
   - Add these variables:
     ```
     ANTHROPIC_API_KEY=your-api-key-here
     PORT=3000
     ```

4. **Wait for Deployment**:
   - Railway will automatically detect it's a Node.js app
   - It will run `npm install` and `npm start`
   - Wait 2-3 minutes for deployment

5. **Get Your URL**:
   - Go to "Settings" tab
   - Click "Generate Domain"
   - You'll get a URL like: `https://hcd-listing-generator.up.railway.app`

### Step 4: Test Your Deployment

Visit your Railway URL and test:
- Click "Load Example"
- Click "Generate"
- Try the chat feature

## Alternative: Deploy Without GitHub

If you don't want to use GitHub:

1. **Install Railway CLI**:
   ```bash
   npm install -g @railway/cli
   ```

2. **Login**:
   ```bash
   railway login
   ```

3. **Initialize and Deploy**:
   ```bash
   railway init
   railway up
   ```

4. **Add Environment Variables**:
   ```bash
   railway variables set ANTHROPIC_API_KEY=your-api-key-here
   ```

5. **Open Your App**:
   ```bash
   railway open
   ```

## Important Security Notes

- ✅ `.env` file is already in `.gitignore` - your API key won't be committed
- ✅ Set environment variables in Railway, not in code
- ✅ Keep your GitHub repository **Private** to protect your API key
- ✅ Never share your Railway deployment URL publicly (uses your API key)

## Updating Your Deployment

After making changes locally:

```bash
git add .
git commit -m "Description of changes"
git push
```

Railway will automatically redeploy!

## Troubleshooting

### "Missing API key" error
- Go to Railway → Variables
- Make sure `ANTHROPIC_API_KEY` is set correctly

### Build failed
- Check Railway logs
- Make sure `package.json` has all dependencies

### Can't access the URL
- Wait 2-3 minutes after deployment
- Check Railway logs for errors
- Make sure domain is generated in Settings

## Cost Information

**Railway Free Tier:**
- $5 free credit per month
- More than enough for light team use
- Monitor usage in Railway dashboard

**API Costs:**
- Claude Sonnet 4.5: ~$3 per million input tokens
- ~$15 per million output tokens
- Typical listing: ~$0.01-0.02 per generation

---

**Need Help?**
- Railway Docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway

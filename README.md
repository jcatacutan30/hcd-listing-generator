# HCD Amazon Listing Generator

Professional Amazon listing generator for Head Case Designs using Claude AI and Helium 10 integration.

## 🚀 Features

- ✅ **Claude Sonnet 4 Integration** - Smart, non-repetitive content generation
- ✅ **Helium 10 CSV Import** - Direct keyword research integration
- ✅ **Amazon 2025 Compliance** - Automatic validation
- ✅ **Category-Aware** - Generates appropriate content for each product type
- ✅ **HCD Document Format** - Professional internal documentation
- ✅ **Competitor Analysis** - Differentiate from competitors
- ✅ **Backend API** - Secure API key management

## 📋 Prerequisites

- Node.js 18+ 
- Anthropic API key ([Get one here](https://console.anthropic.com/))
- Helium 10 account (for keyword research)

## 🚀 Deployment

**Want to deploy this for your team?** See [QUICKSTART-RAILWAY.md](QUICKSTART-RAILWAY.md) for a 5-minute deployment guide!

Deploy to Railway and get a shareable URL like `https://your-app.up.railway.app`

---

## 🛠️ Local Setup

### 1. Clone or Download

```bash
# If using git
git clone <your-repo-url>
cd hcd-listing-generator

# Or just extract the folder
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure API Key

```bash
# Copy the example env file
cp .env.example .env

# Edit .env and add your API key
# ANTHROPIC_API_KEY=sk-ant-api03-xxxxx
```

### 4. Start the Server

```bash
npm start
```

Server will start at: **http://localhost:3000**

## 📖 How to Use

### Step 1: Get Keywords from Helium 10

#### Option A: Cerebro (Reverse ASIN)
1. Go to Helium 10 → **Cerebro**
2. Enter 2-3 competitor ASINs
3. Click **"Get Keywords"**
4. Click **"Export"** → Download CSV
5. Upload CSV in the app

#### Option B: Magnet (Keyword Discovery)
1. Go to Helium 10 → **Magnet**
2. Enter seed keyword (e.g., "iphone case")
3. Click **"Get Keywords"**
4. Click **"Export"** → Download CSV
5. Upload CSV in the app

### Step 2: Fill Product Details

- **Brand Name**: Manchester City FC
- **Product Name**: Shockproof Bumper Case
- **Device Name**: iPhone 16 Pro Max
- **Material**: TPU/PC
- **Key Features**: MagSafe Compatible, Military-Grade Protection

### Step 3: Generate

Click **"✨ Generate Amazon Listing"** and wait ~10-30 seconds.

### Step 4: Copy & Use

- Copy **Title** for Amazon product title
- Copy **Bullets** for Amazon bullet points  
- Copy **HCD Format** for internal documentation

## 🏗️ Project Structure

```
hcd-listing-generator/
├── server.js           # Express backend with Claude API
├── package.json        # Dependencies
├── .env               # API keys (create from .env.example)
├── .env.example       # Template for environment variables
├── public/
│   └── index.html     # Frontend UI
└── README.md          # This file
```

## 🔧 Development

### Running in VS Code

1. Open project folder in VS Code
2. Open terminal (Ctrl+\`)
3. Run `npm install`
4. Create `.env` file with your API key
5. Run `npm start`
6. Open browser to `http://localhost:3000`

### Using Claude Code Extension

If you have the Claude Code extension:
1. Open the project in VS Code
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
3. Type "Claude Code: Start Session"
4. Ask Claude to help with development!

## 📊 API Endpoints

### `POST /api/generate`

Generate Amazon listing from product data.

**Request:**
```json
{
  "keywords": [
    { "keyword": "iphone 16 case", "volume": "450000" },
    { "keyword": "magsafe case", "volume": "165000" }
  ],
  "productInfo": {
    "category": "Phone Cases",
    "brandName": "Manchester City FC",
    "productName": "Shockproof Case",
    "deviceName": "iPhone 16 Pro Max",
    "mainMaterial": "TPU/PC",
    "keyFeatures": "MagSafe, Protection"
  },
  "competitors": []
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "title": "Head Case Designs...",
    "bullets": ["**FEATURE** – Description", ...],
    "hcdFormat": "**Product Description:**...",
    "validation": {
      "valid": true,
      "score": 100,
      "issues": [],
      "warnings": []
    }
  }
}
```

### `GET /api/health`

Health check endpoint.

## 🎯 Amazon Compliance Rules

The generator follows Amazon's 2025 guidelines:

- ✅ Title max 200 characters
- ✅ No forbidden characters: `! $ ? _ { } ^ ¬ ¦`
- ✅ No promotional language
- ✅ 5-8 bullets, 150-250 chars each
- ✅ Capitalized benefit format
- ✅ First 1000 characters optimized for A10

## 🔒 Security

- **API Key**: Stored in `.env` file (never committed to git)
- **Backend Only**: Claude API calls happen server-side
- **No Browser Exposure**: API key never sent to browser

## 🐛 Troubleshooting

### "Cannot find module '@anthropic-ai/sdk'"
```bash
npm install
```

### "Missing API key"
Check your `.env` file has:
```
ANTHROPIC_API_KEY=sk-ant-api03-xxxxx
```

### "Port 3000 already in use"
Change port in `.env`:
```
PORT=3001
```

## 📝 License

MIT

## 👤 Author

Head Case Designs

## 🤝 Contributing

This is an internal tool for Head Case Designs.

---

Made with ❤️ and Claude Sonnet 4

require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Generate listing endpoint
app.post('/api/generate', async (req, res) => {
  try {
    const {
      keywords,
      productInfo,
      competitors
    } = req.body;

    // Validate input
    if (!keywords || keywords.length === 0) {
      return res.status(400).json({ error: 'Keywords are required' });
    }

    if (!productInfo.brandName || !productInfo.productName) {
      return res.status(400).json({ error: 'Brand name and product name are required' });
    }

    // Parse keywords
    const parsedKeywords = keywords.map(kw => ({
      keyword: kw.keyword,
      volume: parseInt(kw.volume) || 0
    })).sort((a, b) => b.volume - a.volume);

    // Build title
    const title = buildTitle(productInfo);

    // Build competitor context
    const competitorInfo = competitors && competitors.length > 0
      ? competitors.filter(c => c.title).map(c => 
          `${c.asin ? `ASIN: ${c.asin}\n` : ''}Title: ${c.title}\nBullets: ${c.bullets}`
        ).join('\n\n')
      : '';

    // Determine product type context
    const categoryContext = getCategoryContext(productInfo.category);

    // Build Claude prompt
    const prompt = buildPrompt({
      productInfo,
      parsedKeywords: parsedKeywords.slice(0, 10),
      competitorInfo,
      categoryContext
    });

    // Call Claude API
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const generatedText = message.content[0].text;

    // Extract bullets
    const bulletMatches = [...generatedText.matchAll(/[•\-]\s*\*\*(.*?)\*\*\s*[–\-]\s*(.*?)(?=\n[•\-]|\n\n|$)/gs)];
    const bullets = bulletMatches.map(match => `**${match[1].trim()}** – ${match[2].trim()}`);

    // Extract HCD format
    const hcdMatch = generatedText.match(/\*\*Product Description:\*\*([\s\S]*?)(?=$|BULLET|---)/i);
    const hcdFormat = hcdMatch ? hcdMatch[0].trim() : generatedText;

    // Validate compliance
    const validation = validateCompliance({ title, bullets, hcdFormat });

    // Send response
    res.json({
      success: true,
      data: {
        title,
        bullets,
        hcdFormat,
        validation,
        backendKeywords: parsedKeywords
          .filter(k => k.volume < 10000)
          .map(k => k.keyword)
          .join(', ')
          .slice(0, 250)
      }
    });

  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({
      error: 'Failed to generate listing',
      message: error.message
    });
  }
});

// Chat endpoint for revisions
app.post('/api/chat', async (req, res) => {
  try {
    const { message, currentListing, history } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!currentListing || !currentListing.title) {
      return res.status(400).json({ error: 'Current listing is required' });
    }

    // Build conversation history for Claude
    const messages = [];

    // Add initial context
    const bullets = currentListing.bullets || [];
    const description = currentListing.hcdFormat || 'No description available';

    messages.push({
      role: 'user',
      content: `I have an Amazon listing for Head Case Designs. Here's the current listing:

TITLE: ${currentListing.title}

BULLETS:
${bullets.map((b, i) => `${i + 1}. ${b}`).join('\n')}

DESCRIPTION:
${description}

Please help me revise or improve this listing based on my requests.`
    });

    messages.push({
      role: 'assistant',
      content: 'I understand. I have your current Amazon listing. How would you like me to help you improve it?'
    });

    // Add chat history
    if (history && history.length > 0) {
      history.forEach(h => {
        if (h.role !== 'error') {
          messages.push({
            role: h.role === 'user' ? 'user' : 'assistant',
            content: h.content
          });
        }
      });
    }

    // Add current message
    messages.push({
      role: 'user',
      content: message
    });

    // Call Claude API
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      messages
    });

    const assistantMessage = response.content[0].text;

    // Check if the response contains updated listing elements
    let updatedListing = null;

    // Try to extract updated bullets
    const bulletMatches = [...assistantMessage.matchAll(/[•\-]\s*\*\*(.*?)\*\*\s*[–\-]\s*(.*?)(?=\n[•\-]|\n\n|$)/gs)];
    if (bulletMatches.length >= 5) {
      updatedListing = updatedListing || {};
      updatedListing.bullets = bulletMatches.map(match => `**${match[1].trim()}** – ${match[2].trim()}`);
    }

    // Try to extract updated title
    const titleMatch = assistantMessage.match(/(?:TITLE|Title):\s*(.+?)(?=\n|$)/i);
    if (titleMatch) {
      updatedListing = updatedListing || {};
      updatedListing.title = titleMatch[1].trim();
    }

    res.json({
      success: true,
      message: assistantMessage,
      updatedListing
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'Failed to process chat message',
      message: error.message
    });
  }
});

// Helper functions
function buildTitle(productInfo) {
  const { brandName, designName, lineupName, productName, deviceName, category, keyFeatures } = productInfo;
  const isCaseProduct = category.includes('Cases') || category.includes('Holders');
  const hasMagSafe = keyFeatures?.toLowerCase().includes('magsafe');
  
  let title = 'Head Case Designs Officially Licensed ';
  if (brandName) title += brandName + ' ';
  if (designName) title += designName + ' ';
  if (lineupName) title += lineupName + ' ';
  if (productName) title += productName + ' ';
  if (isCaseProduct && deviceName && category !== 'Room Accessories') {
    title += 'Compatible with ' + deviceName;
    if (hasMagSafe) title += ' and Compatible with MagSafe';
  }
  
  return title.trim();
}

function getCategoryContext(category) {
  const contexts = {
    'Phone Cases': 'This is a PHONE CASE. Focus on: phone protection, screen protection, camera protection, drop protection, grip, pocket-friendly design, and wireless charging compatibility.',
    'Laptop Cases': 'This is a LAPTOP CASE/SLEEVE. Focus on: laptop protection, padding, scratch resistance, portability, zipper/closure quality, compartments. DO NOT mention phone-specific features.',
    'Audio Cases': 'This is an AUDIO DEVICE CASE. Focus on: device protection, portability, carabiner/clip, shock absorption. DO NOT mention phone-specific features.',
    'Tablet Cases': 'This is a TABLET CASE. Focus on: tablet protection, stand functionality, auto sleep/wake, screen protection, corner protection, and wireless charging compatibility.',
    'Room Accessories': 'This is a ROOM ACCESSORY (cushion, mug, etc.). Focus on: design, quality, comfort (if applicable), material quality, aesthetic appeal. DO NOT mention device protection.',
    'Holders & Clips': 'This is a HOLDER/CLIP accessory. Focus on: secure attachment, versatility, durability, compatibility, portability, and ease of use.',
    'Portable Power': 'This is a PORTABLE POWER product (power bank, charger). Focus on: charging capacity, compatibility, safety features, portability, and charging speed.',
    'Gaming/Office Accessory': 'This is a GAMING/OFFICE ACCESSORY (mouse pad, desk mat, cable organizer, etc.). Focus on: desktop organization, ergonomics, non-slip features, surface quality, size, durability, and design aesthetics. DO NOT mention device protection features.'
  };
  return contexts[category] || '';
}

function buildPrompt({ productInfo, parsedKeywords, competitorInfo, categoryContext }) {
  const { brandName, productName, deviceName, mainMaterial, keyFeatures, uniqueSellingPoints, category } = productInfo;
  
  return `You are an expert Amazon listing copywriter for Head Case Designs following Amazon's 2025 best practices.

CRITICAL - PRODUCT CATEGORY: ${category}
${categoryContext}

PRODUCT INFORMATION:
- Brand: ${brandName}
- Product: ${productName}
- Device: ${deviceName || 'N/A'}
- Material: ${mainMaterial}
- Key Features: ${keyFeatures}
- USPs: ${uniqueSellingPoints}

TOP KEYWORDS (use naturally in first 1000 characters):
${parsedKeywords.map((k, i) => `${i + 1}. ${k.keyword} (${k.volume.toLocaleString()} searches/month)`).join('\n')}

${competitorInfo ? `COMPETITORS (analyze but differentiate from):\n${competitorInfo}\n\n` : ''}

AMAZON COMPLIANCE RULES:
- Title max 200 characters (optimal 150)
- NO forbidden characters: ! $ ? _ { } ^ ¬ ¦
- NO promotional language: "best", "top-rated", "#1"
- 5-8 bullets, each 150-250 characters
- Begin each bullet with **CAPITALIZED BENEFIT**
- First 1000 characters of bullets are indexed by A10 algorithm

Generate 7 Amazon bullet points in this EXACT format:

• **OFFICIALLY LICENSED** – Authentic ${brandName} designs with premium print quality
• **PRECISION FIT** – Custom-molded for ${deviceName} with exact cutouts
• **MILITARY-GRADE PROTECTION** – MIL-STD-810H certified with drop protection
• **[FEATURE]** – [Benefit description]
• **[FEATURE]** – [Benefit description]
• **MADE IN THE UK** – Using premium ${mainMaterial} materials
• **HEAD CASE DESIGNS QUALITY** – 15+ years expertise in premium accessories

Also generate HCD Document Format with:
**Product Description:** (2-3 paragraphs)
**Features:** (bulleted list)
**Supplied:** 1 x ${productName}

Return ONLY the bullets and HCD format, no preamble.`;
}

function validateCompliance({ title, bullets, hcdFormat }) {
  const issues = [];
  const warnings = [];
  
  // Title validation
  if (title.length > 200) issues.push(`Title too long (${title.length}/200 chars)`);
  if (title.length < 80) warnings.push(`Title short (${title.length} chars - optimal 80-150)`);
  
  // Check forbidden characters
  if (/[!$?_{}^¬¦]/.test(title)) {
    issues.push('Title contains forbidden characters');
  }
  
  // Check promotional language
  if (/\b(best|top-rated|#1|number one)\b/i.test(title)) {
    issues.push('Title contains promotional language');
  }
  
  // Bullet validation
  if (bullets.length < 5) {
    warnings.push(`Only ${bullets.length} bullets (recommend 5-8)`);
  }
  
  bullets.forEach((bullet, i) => {
    const cleanBullet = bullet.replace(/\*\*/g, '');
    if (cleanBullet.length > 500) warnings.push(`Bullet ${i + 1} is long`);
    if (cleanBullet.length < 100) warnings.push(`Bullet ${i + 1} is short`);
  });
  
  return {
    valid: issues.length === 0,
    issues,
    warnings,
    score: Math.max(0, 100 - (issues.length * 20) - (warnings.length * 5))
  };
}

// Global error handler - ensures JSON responses
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 HCD Listing Generator running on http://localhost:${PORT}`);
  console.log(`📝 API endpoint: http://localhost:${PORT}/api/generate`);
  console.log(`✅ Health check: http://localhost:${PORT}/api/health`);
});

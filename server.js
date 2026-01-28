require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Initialize Google Gemini client
const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Middleware
app.use(express.json({ limit: '50mb' }));
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
      competitors,
      productImage
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
          `Title: ${c.title}\nBullets: ${c.bullets}`
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

    // Build message content with optional image
    const messageContent = [];

    if (productImage) {
      // Extract base64 data and media type
      const matches = productImage.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        const mediaType = matches[1];
        const base64Data = matches[2];

        messageContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Data
          }
        });
        messageContent.push({
          type: 'text',
          text: 'Analyze this product image and use the visual details to enhance the listing description. Focus on design elements, colors, patterns, and physical features you can see.\n\n' + prompt
        });
      } else {
        messageContent.push({ type: 'text', text: prompt });
      }
    } else {
      messageContent.push({ type: 'text', text: prompt });
    }

    // Call Claude API
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: messageContent
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

    // Try to extract updated bullets - more flexible pattern
    const bulletMatches = [...assistantMessage.matchAll(/[•\-]\s*\*\*(.*?)\*\*\s*[–\-—]\s*(.*?)(?=\n[•\-]|\n\n|$)/gs)];
    if (bulletMatches.length >= 3) {
      updatedListing = updatedListing || {};
      updatedListing.bullets = bulletMatches.map(match => `**${match[1].trim()}** – ${match[2].trim()}`);
    }

    // Try to extract updated title
    const titleMatch = assistantMessage.match(/(?:TITLE|Title):\s*(.+?)(?=\n|$)/i);
    if (titleMatch) {
      updatedListing = updatedListing || {};
      updatedListing.title = titleMatch[1].trim();
    }

    // Try to extract updated description/HCD format - more flexible
    const descMatch = assistantMessage.match(/\*\*Product Description:\*\*([\s\S]*?)(?=\n\n\*\*|$)/i);
    if (descMatch) {
      updatedListing = updatedListing || {};
      // Get the full HCD format including Features and Supplied
      const fullDescMatch = assistantMessage.match(/\*\*Product Description:\*\*([\s\S]*)/i);
      updatedListing.hcdFormat = fullDescMatch ? fullDescMatch[0].trim() : descMatch[0].trim();
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

// Generate inspiration images endpoint
app.post('/api/generate-images', async (req, res) => {
  try {
    const { productInfo, bullets } = req.body;

    if (!productInfo || !bullets || bullets.length === 0) {
      return res.status(400).json({ error: 'Product info and bullets are required' });
    }

    const { brandName, designName, productName, category } = productInfo;

    // Filter bullets - exclude manufacturing and licensing
    const filteredBullets = bullets.filter(bullet => {
      const upper = bullet.toUpperCase();
      return !upper.includes('MADE IN') && !upper.includes('ASSEMBLED IN') && !upper.includes('OFFICIALLY LICENSED');
    });
    const topFeatures = filteredBullets.slice(0, 4).map(b => {
      const m = b.match(/\*\*(.*?)\*\*/);
      return m ? m[1] : b.substring(0, 50);
    });

    // Use Claude to generate image concepts and prompts
    const conceptPrompt = `You are a creative director for Amazon listing photography for Head Case Designs.

PRODUCT: ${brandName || ''} ${designName || ''} ${productName || ''}
CATEGORY: ${category}
TOP FEATURES: ${topFeatures.join(', ')}

Generate 6 listing image concepts. For each image, provide:
1. **Image Title** (e.g., "Main Product Shot")
2. **Layout Description** - Detailed description of the image layout, composition, camera angle, lighting
3. **Text Overlays** - Any text/callouts that should appear on the image and where they should be positioned
4. **Gemini Prompt** - A ready-to-paste prompt for Gemini AI image generation

The 6 images should be:
1. MAIN IMAGE - Clean white background. For phone/tablet cases: iPhone 17 Pro Max with the case, front screen overlapping halfway with back view showing case design. Studio lighting.
2. LIFESTYLE IMAGE - Brand-specific context. For ${brandName || 'the brand'}: use a relevant branded environment as blurred background. Hand model holding the phone with case.
3. FEATURE IMAGE - Based on "${topFeatures[0] || 'Protection'}" feature. Close-up showcasing this physical feature.
4. FEATURE IMAGE - Based on "${topFeatures[1] || 'Precision Fit'}" feature. Close-up showcasing this physical feature.
5. FEATURE IMAGE - Based on "${topFeatures[2] || 'Grip'}" feature. Close-up showcasing this physical feature.
6. FEATURE IMAGE - Based on "${topFeatures[3] || 'Slim Design'}" feature. Close-up showcasing this physical feature.

For each Gemini prompt, make it detailed and specific for product photography. Do NOT include any trademark logos or copyrighted imagery in the prompts.

Return as JSON array with objects: { "title": "", "layout": "", "textOverlays": "", "geminiPrompt": "" }
Return ONLY the JSON array, no markdown code fences.`;

    console.log('Generating image concepts with Claude...');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      messages: [{ role: 'user', content: conceptPrompt }]
    });

    const responseText = response.content[0].text.trim();
    // Parse JSON - handle potential markdown fences
    const jsonText = responseText.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    const concepts = JSON.parse(jsonText);

    res.json({
      success: true,
      concepts,
      count: concepts.length
    });

  } catch (error) {
    console.error('Image generation error:', error);
    res.status(500).json({
      error: 'Failed to generate images',
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

// Brand descriptions with {product} placeholder for dynamic product type
const brandDescriptions = {
  'Liverpool Football Club': "Are you a true 'Red' or know someone that is? Why not treat yourself or someone special to an official Liverpool Football Club licensed {product}.",
  'Manchester City FC': "Show your support for the mighty City and let your Blue Moon pride be seen with this official Manchester City Football Club {product}!",
  'Harry Potter': "Immerse yourself in the Wizarding world of Harry Potter with the widest range of official Harry Potter {products} in the market!",
  'WWE': "Are you a fan of the WWE or know someone that is? From all your current superstars, John Cena, Brock Lesnar, Triple H to the classic stars Hulk Hogan, Stone Cold Steve Austin, The Rock, The Undertaker and their iconic logos and quotes, we have you covered with the largest collection of official WWE {products} in the market!",
  'NBA': "Show your love for your favourite NBA team with these official National Basketball Association {products}! No matter whom you support, we got you covered with all 30 Teams fighting for glory with these official NBA {products}!",
  'NFL': "Show your love for your favourite NFL team with these official National Football League {products}! No matter whom you support, we got you covered with all 32 Teams fighting for glory with these official NFL {products}!"
};

// Get product terminology based on category and product name
function getProductTerminology(category, productName) {
  const productNameLower = (productName || '').toLowerCase();

  // Check product name for specific product types
  if (productNameLower.includes('magnetic car phone mount with wireless charger') ||
      productNameLower.includes('car charger') || productNameLower.includes('wireless car')) {
    return { singular: 'Magnetic Car Phone Mount with Wireless Charger', plural: 'Magnetic Car Phone Mounts with Wireless Chargers' };
  }
  if (productNameLower.includes('magnetic car phone mount') || productNameLower.includes('magnetic mount')) {
    return { singular: 'Magnetic Car Phone Mount', plural: 'Magnetic Car Phone Mounts' };
  }
  if (productNameLower.includes('car phone mount') || productNameLower.includes('car mount') || productNameLower.includes('car clip')) {
    return { singular: 'Car Phone Mount', plural: 'Car Phone Mounts' };
  }
  if (productNameLower.includes('desk mat')) {
    return { singular: 'Desk Mat', plural: 'Desk Mats' };
  }
  if (productNameLower.includes('water bottle')) {
    return { singular: 'Water Bottle', plural: 'Water Bottles' };
  }
  if (productNameLower.includes('gaming floor mat') || productNameLower.includes('floor mat')) {
    return { singular: 'Gaming Floor Mat', plural: 'Gaming Floor Mats' };
  }
  if (productNameLower.includes('mouse pad') || productNameLower.includes('mousepad')) {
    return { singular: 'Mouse Pad', plural: 'Mouse Pads' };
  }

  // Category-based defaults
  const categoryTerms = {
    'Phone Cases': { singular: 'phone case', plural: 'phone cases' },
    'Laptop Cases': { singular: 'laptop case', plural: 'laptop cases' },
    'Audio Cases': { singular: 'case', plural: 'cases' },
    'Tablet Cases': { singular: 'tablet and phone case', plural: 'tablet and phone cases' },
    'Room Accessories': { singular: 'product', plural: 'products' },
    'Holders & Clips': { singular: 'holder', plural: 'holders' },
    'Portable Power': { singular: 'charger', plural: 'chargers' },
    'Gaming/Office Accessory': { singular: 'accessory', plural: 'accessories' }
  };

  return categoryTerms[category] || { singular: 'case', plural: 'cases' };
}

function buildPrompt({ productInfo, parsedKeywords, competitorInfo, categoryContext }) {
  const { brandName, productName, deviceName, mainMaterial, keyFeatures, uniqueSellingPoints, category, countryOfManufacture } = productInfo;

  // Determine manufacturing language based on category
  let manufacturingBullet = '';
  let manufacturingFeature = '';

  if (countryOfManufacture) {
    const isAssembled = category === 'Holders & Clips' || category === 'Portable Power';
    const prefix = isAssembled ? 'Assembled' : 'Made';
    const countryName = countryOfManufacture.toUpperCase();
    const productNameLower = (productName || '').toLowerCase();

    // Determine manufacturing bullet text based on product type
    let manufacturingText = '';

    if (productNameLower.includes('floor mat') || productNameLower.includes('gaming mat') || productNameLower.includes('desk mat') || productNameLower.includes('area rug') || productNameLower.includes('gaming rug')) {
      // Floor mats / Gaming mats / Desk mats
      manufacturingText = `Using premium materials and cutting-edge production techniques, ensuring superior quality, durability, and precision fit for your gaming space. This gaming rug and area rug features a thick, soft crystal velvet surface with plush texture and reinforced stitched edges, delivering professional-grade performance as both stylish room décor and functional floor protection.`;
    } else if (category === 'Room Accessories' || !deviceName || deviceName === 'N/A') {
      // Products without specific devices
      manufacturingText = `Using premium materials and cutting-edge production techniques, ensuring superior quality, durability, and precision.`;
    } else {
      // Products with devices (phone cases, tablet cases, etc.)
      manufacturingText = `Using premium materials and cutting-edge production techniques, ensuring superior quality, durability, and precision fit for your device.`;
    }

    manufacturingBullet = `• **${prefix.toUpperCase()} IN THE ${countryName}** – ${manufacturingText}`;
    manufacturingFeature = `${prefix} in the ${countryOfManufacture}`;
  }

  // Get brand description with correct product terminology
  let brandDescriptionSection = '';
  if (brandName && brandDescriptions[brandName]) {
    const terms = getProductTerminology(category, productName);
    let brandDesc = brandDescriptions[brandName];
    brandDesc = brandDesc.replace(/\{product\}/g, terms.singular);
    brandDesc = brandDesc.replace(/\{products\}/g, terms.plural);
    brandDescriptionSection = `\nBRAND DESCRIPTION (MUST appear at the BEGINNING of Product Description, BEFORE any product-specific content):\n"${brandDesc}"\n`;
  }

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
${countryOfManufacture ? `- Country: ${countryOfManufacture}` : ''}

TOP KEYWORDS (use naturally in first 1000 characters):
${parsedKeywords.map((k, i) => `${i + 1}. ${k.keyword} (${k.volume.toLocaleString()} searches/month)`).join('\n')}

${competitorInfo ? `COMPETITORS (analyze but differentiate from):\n${competitorInfo}\n\n` : ''}${brandDescriptionSection}
AMAZON COMPLIANCE RULES:
- Title max 200 characters (optimal 150)
- NO forbidden characters: ! $ ? _ { } ^ ¬ ¦
- NO promotional language: "best", "top-rated", "#1"
- 5-8 bullets, each 150-250 characters
- Begin each bullet with **CAPITALIZED BENEFIT**
- First 1000 characters of bullets are indexed by A10 algorithm

Generate 7 Amazon bullet points in this EXACT format${manufacturingBullet ? `, with the FIRST bullet being the manufacturing bullet shown below` : ''}:

${manufacturingBullet ? manufacturingBullet + '\n' : ''}• **OFFICIALLY LICENSED** – Authentic ${brandName} designs with premium print quality
• **PRECISION FIT** – Custom-molded for ${deviceName} with exact cutouts
• **MILITARY-GRADE PROTECTION** – MIL-STD-810H certified with drop protection
• **[FEATURE]** – [Benefit description]
• **[FEATURE]** – [Benefit description]
• **[FEATURE]** – [Benefit description]

${manufacturingBullet ? 'IMPORTANT: The manufacturing bullet above MUST be the FIRST bullet in your output. Do NOT modify its text.' : ''}

Also generate HCD Document Format with:
**Product Description:** (2-3 paragraphs${brandDescriptionSection ? ' - MUST start with the BRAND DESCRIPTION above as the FIRST paragraph, followed by product-specific content' : ''})
**Features:** (bulleted list${manufacturingFeature ? ` - ALWAYS start with "${manufacturingFeature}" as the FIRST feature` : ''})
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

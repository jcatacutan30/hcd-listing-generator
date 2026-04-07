require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const JSZip = require('jszip');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

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

    if (!productInfo || !productInfo.brandName || !productInfo.productName) {
      return res.status(400).json({ error: 'Brand name and product name are required' });
    }

    // Parse keywords — sort by tier first, then volume
    const tierOrder = { 'Tier 1': 1, 'Tier 2': 2, 'Tier 3': 3, 'Tier 4': 4 };
    const parsedKeywords = keywords.map(kw => ({
      keyword: kw.keyword,
      volume: parseInt(kw.volume) || 0,
      tier: kw.tier || 'Tier 2'
    })).sort((a, b) => {
      const ta = tierOrder[a.tier] || 99;
      const tb = tierOrder[b.tier] || 99;
      if (ta !== tb) return ta - tb;
      return b.volume - a.volume;
    });

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
      parsedKeywords: parsedKeywords.slice(0, 25),
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
      model: 'claude-opus-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: messageContent
      }]
    });

    const generatedText = message.content[0].text;

    // Convert ALL CAPS bullet header to Title Case, preserving short abbreviations
    function toTitleCaseHeader(header) {
      if (header !== header.toUpperCase()) return header; // already mixed/title case
      return header.split(' ').map(word => {
        if (/^[A-Z0-9&\/]{1,4}$/.test(word)) return word; // keep abbreviations e.g. USA, UK, BPA, FC
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }).join(' ');
    }

    // Extract bullets
    const bulletMatches = [...generatedText.matchAll(/[•\-]\s*\*\*(.*?)\*\*\s*[–\-]\s*(.*?)(?=\n[•\-]|\n\n|$)/gs)];
    const bullets = bulletMatches.map(match => `**${toTitleCaseHeader(match[1].trim())}** – ${match[2].trim()}`);

    // Extract suggested title
    const suggestedTitleMatch = generatedText.match(/\*\*Suggested Title:\*\*\s*(.+)/i);
    const suggestedTitle = suggestedTitleMatch ? suggestedTitleMatch[1].trim() : null;

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
        suggestedTitle,
        bullets,
        hcdFormat,
        validation,
        backendKeywords: buildBackendKeywords(parsedKeywords, title)
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

BACKEND KEYWORDS: ${currentListing.backendKeywords || ''}

Please help me revise or improve this listing based on my requests.

IMPORTANT: When you make changes, you MUST include a JSON block at the END of your response in this exact format:
\`\`\`json
{
  "title": "the full updated title if changed, or null if unchanged",
  "bullets": ["bullet 1 with **Bold** – description", "bullet 2..."] or null if unchanged,
  "hcdFormat": "the full updated description if changed, or null if unchanged",
  "backendKeywords": "updated keywords if changed, or null if unchanged"
}
\`\`\`
Always include this JSON block when making ANY changes. Keep the **Bold Title** – description format for bullets.`
    });

    messages.push({
      role: 'assistant',
      content: 'I understand. I have your current Amazon listing and will include a JSON block with any changes I make. How would you like me to help you improve it?'
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
      model: 'claude-opus-4-6',
      max_tokens: 4000,
      messages
    });

    const assistantMessage = response.content[0].text;

    // Extract JSON block from response
    let updatedListing = null;
    const jsonMatch = assistantMessage.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        updatedListing = {};
        if (parsed.title) updatedListing.title = parsed.title;
        if (parsed.bullets && Array.isArray(parsed.bullets)) updatedListing.bullets = parsed.bullets;
        if (parsed.hcdFormat) updatedListing.hcdFormat = parsed.hcdFormat;
        if (parsed.backendKeywords) updatedListing.backendKeywords = parsed.backendKeywords;
        // If all values are null, set updatedListing to null
        if (!parsed.title && !parsed.bullets && !parsed.hcdFormat && !parsed.backendKeywords) {
          updatedListing = null;
        }
      } catch (e) {
        console.error('Failed to parse JSON from chat response:', e.message);
        updatedListing = null;
      }
    }

    // Strip the JSON block from the displayed message
    const displayMessage = assistantMessage.replace(/```json\s*[\s\S]*?```/, '').trim();

    res.json({
      success: true,
      message: displayMessage,
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
      model: 'claude-opus-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: conceptPrompt }]
    });

    const responseText = response.content[0].text.trim();
    // Parse JSON - handle potential markdown fences
    const jsonMatch = responseText.match(/```json?\s*([\s\S]*?)```/);
    const jsonText = jsonMatch ? jsonMatch[1].trim() : responseText;
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
function buildBackendKeywords(parsedKeywords, title) {
  // Extract unique words already in the title (case-insensitive)
  const titleWords = new Set(
    title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1)
  );

  // Prefer Tier 3+ keywords for backend (supporting/long-tail terms not used in title/bullets)
  // Fall back to all keywords if no tier info is provided
  const hasTierInfo = parsedKeywords.some(k => k.tier && k.tier !== 'Tier 2');
  const backendPool = hasTierInfo
    ? parsedKeywords.filter(k => k.tier === 'Tier 3' || k.tier === 'Tier 4' || k.tier === 'Tier 2')
    : parsedKeywords;

  // Filter keyword phrases: exclude any keyword whose words are ALL already in the title
  const filteredKeywords = backendPool
    .map(k => k.keyword)
    .filter(keyword => {
      const kwWords = keyword.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
      // Keep if at least one word is NOT already in the title
      return kwWords.some(w => w.length > 1 && !titleWords.has(w));
    });

  // Join with spaces (not commas) per Amazon best practice, limit to 249 bytes
  let result = filteredKeywords.join(' ');
  // Trim to 249 bytes (using Buffer for accurate byte counting)
  while (Buffer.byteLength(result, 'utf8') > 249) {
    const words = result.split(' ');
    words.pop();
    result = words.join(' ');
  }
  return result;
}

function buildTitle(productInfo) {
  const { brandName, designName, lineupName, productName, productColour } = productInfo;

  // Build title: Head Case Designs Officially Licensed [Brand] [Design] [Lineup] [Colour] [Product]
  let title = 'Head Case Designs Officially Licensed ';
  if (brandName) title += brandName + ' ';
  if (designName) title += designName + ' ';
  if (lineupName) title += lineupName + ' ';
  if (productColour) title += productColour + ' ';
  if (productName) title += productName;

  title = title.trim();

  // Enforce 200-character Amazon limit
  if (title.length > 200) {
    title = title.substring(0, 197) + '...';
  }

  return title;
}

function getCategoryContext(category) {
  const contexts = {
    'Phone Cases': 'This is a PHONE CASE. Focus on: phone protection, screen protection, camera protection, drop protection, grip, slim profile, raised bezels, pocket-friendly design, and wireless charging compatibility. Naturally incorporate terms like "protective case", "slim case", "shockproof", "drop protection" where accurate.',
    'Laptop Cases': 'This is a LAPTOP CASE/SLEEVE. Focus on: laptop protection, padding, scratch resistance, portability, zipper/closure quality, compartments. DO NOT mention phone-specific features.',
    'Audio Cases': 'This is an AUDIO DEVICE CASE. Focus on: device protection, portability, carabiner/clip, shock absorption. DO NOT mention phone-specific features.',
    'Tablet Cases': 'This is a TABLET CASE. Focus on: tablet protection, stand functionality, auto sleep/wake, screen protection, corner protection, and wireless charging compatibility.',
    'Room Accessories': 'This is a ROOM ACCESSORY. Tailor copy to the specific product type. For soft goods (cushions, blankets, pillows): focus on comfort, fill quality, fabric softness, size, and decorative appeal. For hard goods (mugs, cups): focus on capacity, ceramic/material quality, dishwasher safety, and gift appeal. For all: focus on design, print quality, and aesthetic appeal. DO NOT mention device protection.',
    'Holders & Clips': 'This is a HOLDER/CLIP accessory. Focus on: secure attachment, versatility, durability, compatibility, portability, and ease of use.',
    'Portable Power': 'This is a PORTABLE POWER product (power bank, charger). Focus on: charging capacity, compatibility, safety features, portability, and charging speed.',
    'Gaming/Office Accessory': 'This is a GAMING/OFFICE ACCESSORY (mouse pad, desk mat, cable organizer, etc.). Focus on: desktop organization, ergonomics, non-slip features, surface quality, size, durability, and design aesthetics. DO NOT mention device protection features.',
    'Water Bottles': 'This is a WATER BOTTLE. Focus on: capacity, materials (BPA-free, stainless steel), insulation (hot/cold retention), leak-proof lid, portability, and design. DO NOT mention device protection features.',
    'Wall Art / Metal Prints': 'This is a METAL WALL ART PRINT. Focus on: print quality (UV-printed, fade-resistant), material (aluminum, metal), wall mounting (magnetic mount, no drill, easy hang, tool-free install), lightweight design, room decor appeal (living room, bedroom, office, gaming room), and officially licensed artwork. Naturally incorporate: "metal wall art", "metal print", "wall decor", "aluminum wall art", "metal poster", "easy hang wall art", "no drill wall art", "magnetic wall mount", "UV printed", "fade resistant". DO NOT mention device protection or phone-specific features.',
    'MagSafe Accessories': 'This is a MAGSAFE ACCESSORY. Focus on: MagSafe magnetic attachment, iPhone compatibility (iPhone 12 and later), snap-on convenience, wireless charging pass-through where applicable, and the specific product function. If the product is a water bottle, MUST naturally include these high-priority exact phrases across bullets and description: "stainless steel water bottle", "travel water bottle", "running water bottle", "phone stand for recording", "water bottle phone mount", "magsafe phone grip", "magsafe accessories", "water jug", "flask", "hands free" (unhyphenated at least once), "leak proof" (unhyphenated at least once), "water bottles" (plural at least once, e.g. "our water bottles feature..."), "360 rotate" or "360-degree rotation". Use both hyphenated and unhyphenated variants for "leak-proof"/"leak proof" and "hands-free"/"hands free" so Amazon indexes both. DO NOT mention non-MagSafe attachment methods unless relevant.'
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
    'Gaming/Office Accessory': { singular: 'accessory', plural: 'accessories' },
    'Water Bottles': { singular: 'water bottle', plural: 'water bottles' },
    'MagSafe Accessories': { singular: 'MagSafe accessory', plural: 'MagSafe accessories' },
    'Wall Art / Metal Prints': { singular: 'metal wall art print', plural: 'metal wall art prints' }
  };

  return categoryTerms[category] || { singular: 'case', plural: 'cases' };
}

function buildPrompt({ productInfo, parsedKeywords, competitorInfo, categoryContext }) {
  const { brandName, productName, deviceName, mainMaterial, productColour, keyFeatures, uniqueSellingPoints, milStdCertified, category, countryOfManufacture } = productInfo;
  const usp = uniqueSellingPoints || 'Officially licensed artwork, premium materials, precision fit';

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

  // Determine if this is a case/device product for category-aware bullets
  const isCaseProduct = category.includes('Cases') || category.includes('Holders');

  // Build category-aware example bullets
  let categoryExampleBullets = '';
  if (isCaseProduct) {
    if (milStdCertified) {
      categoryExampleBullets = `• **[KEYWORD-RICH BENEFIT]** – MIL-STD-810H certified drop protection for ${deviceName || 'your device'}
• **[KEYWORD-RICH BENEFIT]** – Custom-molded for ${deviceName || 'your device'} with precise cutouts for all ports and buttons`;
    } else {
      categoryExampleBullets = `• **[KEYWORD-RICH BENEFIT]** – Durable protection with raised bezels for screen and camera
• **[KEYWORD-RICH BENEFIT]** – Custom-molded for ${deviceName || 'your device'} with precise cutouts for all ports and buttons`;
    }
  } else if (category === 'Gaming/Office Accessory') {
    categoryExampleBullets = `• **[KEYWORD-RICH BENEFIT]** – Premium non-slip rubber base keeps your mat firmly in place during use
• **[KEYWORD-RICH BENEFIT]** – Smooth, optimized surface for precise mouse tracking and comfortable wrist support`;
  } else if (category === 'Room Accessories') {
    categoryExampleBullets = `• **[KEYWORD-RICH BENEFIT]** – Premium quality materials with vibrant, fade-resistant printed design
• **[KEYWORD-RICH BENEFIT]** – Perfect as a gift or to complement your room decor`;
  } else if (category === 'Portable Power') {
    categoryExampleBullets = `• **[KEYWORD-RICH BENEFIT]** – Fast charging with built-in safety features for reliable power delivery
• **[KEYWORD-RICH BENEFIT]** – Compact, portable design for charging on the go`;
  } else if (category === 'Water Bottles') {
    categoryExampleBullets = `• **[KEYWORD-RICH BENEFIT]** – BPA-free, leak-proof design keeps your drinks secure
• **[KEYWORD-RICH BENEFIT]** – Insulated to maintain temperature for hot and cold beverages`;
  } else if (category === 'MagSafe Accessories') {
    categoryExampleBullets = `• **Water Bottle Phone Mount and MagSafe Accessories** – [Describe the magnetic phone mount function, include "water bottle phone mount", "hands free", "phone stand for recording"]
• **Stainless Steel Water Bottle with Leak Proof Design** – [Describe insulation, BPA-free stainless steel water bottle, leak proof and leak-proof variants, travel water bottle, running water bottle]
• **MagSafe Phone Grip and 360 Rotate Stand** – [Describe magsafe phone grip, 360 rotate, content creation, flask/water jug use cases]`;
  } else {
    categoryExampleBullets = `• **[KEYWORD-RICH BENEFIT]** – [Benefit using primary keywords naturally]
• **[KEYWORD-RICH BENEFIT]** – [Benefit using primary keywords naturally]`;
  }

  // Get brand description with correct product terminology
  let brandDescriptionSection = '';
  if (brandName && brandDescriptions[brandName]) {
    const terms = getProductTerminology(category, productName);
    let brandDesc = brandDescriptions[brandName];
    brandDesc = brandDesc.replace(/\{product\}/g, terms.singular);
    brandDesc = brandDesc.replace(/\{products\}/g, terms.plural);
    brandDescriptionSection = `\nBRAND DESCRIPTION (this MUST be the FIRST paragraph of the Product Description, before any product detail):\n"${brandDesc}"\n`;
  }

  return `You are an expert Amazon listing copywriter for Head Case Designs following Amazon's 2025 best practices.

CRITICAL - PRODUCT CATEGORY: ${category}
${categoryContext}

PRODUCT INFORMATION:
- Brand: ${brandName}
- Product: ${productName}
- Device: ${deviceName || 'N/A'}
- Material: ${mainMaterial}
${productColour ? `- Colour: ${productColour}` : ''}
- Key Features: ${keyFeatures}
- USPs: ${usp}
${countryOfManufacture ? `- Country: ${countryOfManufacture}` : ''}

KEYWORD STRATEGY (place keywords exactly where specified — Amazon indexes exact phrases):
${(() => {
  const hasTiers = parsedKeywords.some(k => k.tier && k.tier !== 'Tier 2');
  if (hasTiers) {
    const t1 = parsedKeywords.filter(k => k.tier === 'Tier 1');
    const t2 = parsedKeywords.filter(k => k.tier === 'Tier 2');
    const t3 = parsedKeywords.filter(k => k.tier === 'Tier 3');
    const t4 = parsedKeywords.filter(k => k.tier === 'Tier 4');
    let out = '';
    if (t1.length) out += `TIER 1 — Use in first 2 bullets AND product description (highest priority):\n${t1.map((k,i) => `${i+1}. ${k.keyword}${k.volume ? ` (${k.volume.toLocaleString()} searches/mo)` : ''}`).join('\n')}\n\n`;
    if (t2.length) out += `TIER 2 — Weave into bullets and description:\n${t2.map((k,i) => `${i+1}. ${k.keyword}${k.volume ? ` (${k.volume.toLocaleString()} searches/mo)` : ''}`).join('\n')}\n\n`;
    if (t3.length) out += `TIER 3 — Include naturally in supporting bullets where they fit:\n${t3.map((k,i) => `${i+1}. ${k.keyword}${k.volume ? ` (${k.volume.toLocaleString()} searches/mo)` : ''}`).join('\n')}\n\n`;
    if (t4.length) out += `TIER 4 — Brand/niche terms, include in at least one bullet:\n${t4.map((k,i) => `${i+1}. ${k.keyword}${k.volume ? ` (${k.volume.toLocaleString()} searches/mo)` : ''}`).join('\n')}`;
    return out.trim();
  } else {
    return `PRIMARY KEYWORDS (use in first 2 bullets):\n${parsedKeywords.slice(0,5).map((k,i) => `${i+1}. ${k.keyword} (${k.volume.toLocaleString()} searches/month)`).join('\n')}\n\nSECONDARY KEYWORDS (weave into remaining bullets):\n${parsedKeywords.slice(5,15).map((k,i) => `${i+6}. ${k.keyword} (${k.volume.toLocaleString()} searches/month)`).join('\n')}\n\nLONG-TAIL KEYWORDS (use in description):\n${parsedKeywords.slice(15,25).map((k,i) => `${i+16}. ${k.keyword} (${k.volume.toLocaleString()} searches/month)`).join('\n')}`;
  }
})()}

${competitorInfo ? `COMPETITORS (analyze but differentiate from):\n${competitorInfo}\n\n` : ''}${brandDescriptionSection}
AMAZON COMPLIANCE RULES:
- Title max 200 characters (optimal 150)
- NO forbidden characters: ! $ ? _ { } ^ ¬ ¦
- NO promotional language: "best", "top-rated", "#1"
- 5-8 bullets, each 200-350 characters
- Begin each bullet with a **Title Case Keyword-Rich Benefit** header (use search terms shoppers actually use, e.g., "Shockproof ${brandName} Case", "Drop Protection Cover", "Slim ${mainMaterial || 'TPU'} Case") — Title Case means capitalise each major word. Keep abbreviations in caps (e.g. USA, UK, BPA, LFC, FC, MagSafe, iPhone)
- Front-load high-volume keywords in the first 3 bullets for maximum mobile visibility. Amazon indexes all bullet content.
- Use EXACT keyword phrases from the keyword list — Amazon indexes exact phrases, not just individual words. "stainless steel water bottle" indexes differently from "stainless steel" + "water bottle" separately.
- For hyphenated terms (e.g. "hands-free", "leak-proof"), include BOTH the hyphenated and unhyphenated version at least once each across bullets and description so Amazon indexes both variants.
- One bullet MUST be **OFFICIALLY LICENSED** to establish brand authenticity
${productColour ? `- Naturally mention the product colour (${productColour}) in bullets and description where relevant, e.g. "this ${productColour} ${productName}" — do not force it into every sentence, just weave it in organically` : ''}

TITLE SUGGESTION:
First, generate a keyword-optimised Amazon title suggestion using this fixed prefix:
"Head Case Designs Officially Licensed ${brandName || ''} ${productInfo.designName || ''} ${productInfo.lineupName || ''}"
After the prefix, append the most keyword-rich product name possible using Tier 1 keywords (and Tier 2 if space allows). Max 200 characters total. No forbidden characters (! $ ? _ { } ^ ¬ ¦). No promotional language.
Output it on its own line in this EXACT format:
**Suggested Title:** [full title here]

Then generate between 5 and 8 Amazon bullet points in this EXACT format${manufacturingBullet ? `, with the FIRST bullet being the manufacturing bullet shown below` : ''}:

${manufacturingBullet ? manufacturingBullet + '\n' : ''}• **Officially Licensed ${brandName || ''} ${productName || ''}** – Authentic officially licensed designs with high-resolution UV-printed artwork that won't fade or peel
${categoryExampleBullets}
• **[Title Case Keyword-Rich Benefit]** – [Benefit using secondary keywords naturally]
• **[Title Case Keyword-Rich Benefit]** – [Benefit using secondary keywords naturally]
• **[Title Case Keyword-Rich Benefit]** – [Benefit using secondary keywords naturally]

${manufacturingBullet ? 'IMPORTANT: The manufacturing bullet above MUST be the FIRST bullet in your output. Do NOT modify its text.' : ''}

Also generate HCD Document Format with:
**Product Description:** (EXACTLY 2 paragraphs${brandDescriptionSection ? ' - Paragraph 1: MUST be the exact BRAND DESCRIPTION provided above, word for word, unchanged. Paragraph 2: ONE concise product description paragraph (3-4 sentences max). NO third paragraph.' : ' - ONE concise paragraph, 3-4 sentences max. No more.'})
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
    if (cleanBullet.length > 350) warnings.push(`Bullet ${i + 1} exceeds 350 chars (${cleanBullet.length} chars)`);
    if (cleanBullet.length < 150) warnings.push(`Bullet ${i + 1} is under 150 chars (${cleanBullet.length} chars)`);
  });
  
  return {
    valid: issues.length === 0,
    issues,
    warnings,
    score: Math.max(0, 100 - (issues.length * 20) - (warnings.length * 5))
  };
}

// DOCX Download endpoint
app.post('/api/download-docx', async (req, res) => {
  try {
    const { title, bullets, hcdFormat, productInfo } = req.body;
    const { brandName, designName, lineupName, productName, productCode, mainMaterial, productColour } = productInfo || {};

    // Parse hcdFormat into sections
    function parseHcdFormat(text) {
      const result = { descriptionParagraphs: [], features: [], supplied: [] };
      if (!text) return result;
      let section = null;
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (/^\*\*Product Description:\*\*/i.test(line)) { section = 'desc'; continue; }
        if (/^\*\*Features:\*\*/i.test(line)) { section = 'features'; continue; }
        if (/^\*\*Supplied:/i.test(line)) {
          section = 'supplied';
          const inline = line.replace(/^\*\*Supplied:\*\*\s*/i, '').trim();
          if (inline) result.supplied.push(inline);
          continue;
        }
        if (!line) continue;
        if (section === 'desc') result.descriptionParagraphs.push(line);
        else if (section === 'features') result.features.push(line.replace(/^[•\-]\s*/, ''));
        else if (section === 'supplied') result.supplied.push(line.replace(/^[•\-]\s*/, ''));
      }
      return result;
    }

    // Replace actual values with variable placeholders
    function applyVariables(text) {
      if (!text) return text;
      let result = text;
      const replacements = [
        [brandName, '[Brand Name]'],
        [designName, '[Design Name]'],
        [lineupName, '[Lineup Name]'],
        [mainMaterial, '[Material]'],
        [productColour, '[Colour]'],
      ].filter(([val]) => val && val.trim());
      replacements.sort((a, b) => b[0].length - a[0].length);
      for (const [val, placeholder] of replacements) {
        const regex = new RegExp(val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        result = result.replace(regex, placeholder);
      }
      return result;
    }

    // Parse a bullet string into TextRuns (bold keyword + normal description)
    function bulletRuns(text) {
      // Format: **BOLD KEYWORD** – description  OR  BOLD KEYWORD – description
      const stripped = text.replace(/\*\*/g, '');
      const dashIdx = stripped.search(/\s[–\-]\s/);
      if (dashIdx === -1) return [new TextRun({ text: stripped, font: FONT, size: SIZE_BODY })];
      const keyword = stripped.substring(0, dashIdx);
      const rest = stripped.substring(dashIdx);
      return [
        new TextRun({ text: keyword, bold: true, font: FONT, size: SIZE_BODY }),
        new TextRun({ text: rest, font: FONT, size: SIZE_BODY }),
      ];
    }

    const FONT = 'Century Gothic';
    const SIZE_BODY = 20;   // 10pt
    const SIZE_HEADER = 24; // 12pt

    function run(text, opts = {}) {
      return new TextRun({ text, font: FONT, size: SIZE_BODY, ...opts });
    }

    // Helper: bold label paragraph
    function labelPara(label, spaceBefore = 240) {
      return new Paragraph({
        children: [run(label, { bold: true })],
        spacing: { before: spaceBefore, after: 80 },
      });
    }

    // Build one full version of the document content
    function buildVersion(t, b, hcd) {
      const parsed = parseHcdFormat(hcd);
      const children = [];

      // Product heading: [Product Code] – [Product Name]
      const headingText = [productCode, productName].filter(Boolean).join(' – ');
      children.push(new Paragraph({
        children: [run(headingText, { bold: true, size: SIZE_HEADER })],
        spacing: { after: 160 },
      }));

      // Material / Colour
      children.push(new Paragraph({
        children: [run(`Material: ${mainMaterial || ''}${productColour ? ` | Colour: ${productColour}` : ''}`)],
        spacing: { after: 240 },
      }));

      // eBay Title
      children.push(labelPara('eBay Title:', 0));
      children.push(new Paragraph({
        children: [run(`Official Head Case Designs ${productName || ''}`)],
        spacing: { after: 60 },
      }));
      children.push(new Paragraph({
        children: [run(`Official ${[brandName, designName, lineupName, productName].filter(Boolean).join(' ')}`)],
        spacing: { after: 200 },
      }));

      // Amazon Title
      children.push(labelPara('Amazon Title:'));
      children.push(new Paragraph({
        children: [run(t || '')],
        spacing: { after: 240 },
      }));

      // Product Description
      children.push(labelPara('Product Description:'));
      children.push(new Paragraph({ text: '', spacing: { after: 80 } }));
      parsed.descriptionParagraphs.forEach(para => {
        children.push(new Paragraph({
          children: [run(para)],
          spacing: { after: 160 },
        }));
      });

      // Features (short list)
      children.push(labelPara('Features:'));
      parsed.features.forEach(f => {
        children.push(new Paragraph({
          children: [run(f)],
          bullet: { level: 0 },
          spacing: { after: 60 },
        }));
      });

      // Features (for Amazon bullet points)
      children.push(labelPara('Features (for amazon bullet points):'));
      (b || []).forEach(bullet => {
        children.push(new Paragraph({
          children: bulletRuns(bullet),
          spacing: { after: 100 },
        }));
      });

      // Supplied
      children.push(labelPara('Supplied:'));
      parsed.supplied.forEach(item => {
        children.push(new Paragraph({
          children: [run(item)],
          spacing: { after: 60 },
        }));
      });

      return children;
    }

    const baseName = [brandName, designName, lineupName, productName].filter(Boolean).join(' ').substring(0, 60).replace(/[^a-z0-9 \-]/gi, '').trim() || 'listing';

    const docFull = new Document({ sections: [{ children: buildVersion(title, bullets, hcdFormat) }] });
    const docTemplate = new Document({ sections: [{ children: buildVersion(applyVariables(title), (bullets || []).map(applyVariables), applyVariables(hcdFormat)) }] });

    const [bufferFull, bufferTemplate] = await Promise.all([
      Packer.toBuffer(docFull),
      Packer.toBuffer(docTemplate),
    ]);

    const zip = new JSZip();
    zip.file(`${baseName}.docx`, bufferFull);
    zip.file(`${baseName} - Template.docx`, bufferTemplate);
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.zip"`);
    res.send(zipBuffer);
  } catch (error) {
    console.error('DOCX generation error:', error);
    res.status(500).json({ error: 'Failed to generate DOCX', message: error.message });
  }
});

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

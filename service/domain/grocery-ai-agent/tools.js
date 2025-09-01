// service/domain/ai-agent/grocery-tools.js
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { createClient } from 'redis';
import CONFIG from '../../../config.js';

import ChatRepository from "../../data/chat-repository.js";
import ProductRepository from "../../data/product-repository.js";

const client = await createClient({
    url: CONFIG.redisUrl,
}).on('error', (err) => console.log('Redis Client Error', err))
  .connect();

const chatRepository = new ChatRepository();

const productRepository = new ProductRepository();

/**
 * Tool: Direct Answer
 * Answers general grocery/shopping/cooking questions using LLM knowledge only.
 * Does not search the product database - pure knowledge-based responses.
 */
export const directAnswerTool = tool(
    async ({ question }) => {
        console.log(`🧠 Direct answer for: "${question}"`);
        
        try {
            const model = new ChatOpenAI({ 
                temperature: 0.2, 
                model: CONFIG.modelName, 
                apiKey: CONFIG.openAiApiKey 
            });
            
            const systemPrompt = `You are a knowledgeable grocery shopping and cooking assistant. Answer questions about:
- Recipe ingredients and cooking methods
- Food storage and preparation tips  
- Nutritional information and health benefits
- Spices, seasonings, and flavor combinations
- Grocery shopping advice and tips
- Indian cuisine and cooking techniques

Provide helpful, accurate information based on your knowledge. Keep responses concise and practical for someone grocery shopping or cooking.

Do not mention specific product prices or brands - focus on general knowledge and advice.`;

            const response = await model.invoke([
                { role: "system", content: systemPrompt },
                new HumanMessage(question)
            ]);
            
            return response.content;
            
        } catch (error) {
            console.error('Error in direct answer:', error);
            return `Sorry, I had trouble answering your question about "${question}". Please try rephrasing your question.`;
        }
    },
    {
        name: "direct_answer",
        description: "Answer general grocery, cooking, and food-related questions using knowledge. Use for recipe ingredients, cooking tips, food storage, nutrition info, etc.",
        schema: z.object({
            question: z.string().describe("The grocery/cooking question to answer")
        })
    }
);

/**
 * Tool: Search Products
 * Search for specific products in the database using keywords or semantic search
 */
export const searchProductsTool = tool(
    async ({ query, category, maxPrice, minRating, limit = 10, useSemanticSearch = true }) => {
        console.log(`🔍 Searching products: "${query}"`);
        
        try {
            const products = await productRepository.searchProducts({ 
                query, 
                category, 
                maxPrice, 
                minRating, 
                limit,
                useSemanticSearch
            });
            
            if (products.length === 0) {
                return `No products found for "${query}". Try different keywords or check the spelling.`;
            }
            
            const productList = products.map((product, index) => {
                const discountText = product.marketPrice > product.salePrice ? 
                    ` (${Math.round(((product.marketPrice - product.salePrice) / product.marketPrice) * 100)}% off!)` : '';
                const ratingText = product.rating ? ` ⭐${product.rating}` : '';
                const semanticText = product.semanticScore ? ` 🎯${Math.round(product.semanticScore * 100)}% match` : '';
                
                return `${index + 1}. **${product.name}** - ₹${product.salePrice}${discountText}${ratingText}${semanticText}
   ID: ${product.id} | Brand: ${product.brand || 'Generic'} | ${product.category}
   ${product.description.substring(0, 150)}...`;
            }).join('\n\n');
            
            const totalCost = products.reduce((sum, product) => sum + product.salePrice, 0);
            
            return `🛍️ **Found ${products.length} products for "${query}":**

${productList}

💰 **Total if you buy all: ₹${totalCost}**

To add items to cart, use: "add to cart [product IDs]"
Example: "add to cart ${products.slice(0,2).map(p => p.id).join(', ')}"`;
            
        } catch (error) {
            console.error('Error searching products:', error);
            return `Sorry, I had trouble searching for "${query}". Please try again.`;
        }
    },
    {
        name: "search_products",
        description: "Search for specific products in the database. Use when user wants to find actual products to buy.",
        schema: z.object({
            query: z.string().describe("Product search query"),
            category: z.string().optional().describe("Product category filter"),
            maxPrice: z.number().optional().describe("Maximum price filter"),
            minRating: z.number().optional().describe("Minimum rating filter"),
            limit: z.number().optional().describe("Maximum number of results (default: 10)"),
            useSemanticSearch: z.boolean().optional().describe("Use AI-powered semantic search (default: true)")
        })
    }
);

/**
 * Tool: Add to Cart
 * Adds products to the shopping cart using product IDs only
 */
export const addToCartTool = tool(
    async ({ productIds, sessionId }) => {
        console.log(`🛒 Adding products to cart for session: ${sessionId}`);
        
        try {
            if (!productIds || productIds.length === 0) {
                return "Please specify product IDs to add to your cart. You can get product IDs from search results.";
            }

            const cartKey = `cart:${sessionId}`;
            let currentCart = await client.json.get(cartKey, { path: '$' });
            currentCart = currentCart ? currentCart[0] : [];
            
            const itemsToAdd = [];
            const failedIds = [];
            
            // Fetch product details for each ID
            for (const productId of productIds) {
                try {
                    const product = await client.json.get(`product:${productId}`, { path: '$' });
                    if (product && product[0]) {
                        itemsToAdd.push(product[0]);
                    } else {
                        failedIds.push(productId);
                    }
                } catch (error) {
                    failedIds.push(productId);
                }
            }
            
            if (itemsToAdd.length === 0) {
                return `No valid products found for IDs: ${productIds.join(', ')}. Please check the product IDs and try again.`;
            }
            
            // Add items to cart
            let addedCount = 0;
            itemsToAdd.forEach(item => {
                const existingItem = currentCart.find(cartItem => cartItem.id === item.id);
                if (!existingItem) {
                    currentCart.push({
                        id: item.id,
                        name: item.name,
                        brand: item.brand,
                        price: item.salePrice,
                        originalPrice: item.marketPrice,
                        category: item.category,
                        quantity: 1,
                        addedAt: new Date().toISOString()
                    });
                    addedCount++;
                } else {
                    existingItem.quantity += 1;
                    addedCount++;
                }
            });
            
            // Save cart to Redis
            await client.json.set(cartKey, '$', currentCart);
            
            const cartTotal = currentCart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const addedItems = itemsToAdd.map(item => `• ${item.name} - ₹${item.salePrice}`).join('\n');
            
            let response = `✅ **Added ${addedCount} items to Cart:**

${addedItems}

🛒 **Cart Summary:**
- Total items: ${currentCart.reduce((sum, item) => sum + item.quantity, 0)}
- Cart total: ₹${cartTotal}

View your cart anytime by asking "show my cart"!`;

            if (failedIds.length > 0) {
                response += `\n\n⚠️ Could not find products with IDs: ${failedIds.join(', ')}`;
            }
            
            return response;
            
        } catch (error) {
            console.error('Error adding to cart:', error);
            return "Sorry, I had trouble adding items to your cart. Please try again.";
        }
    },
    {
        name: "add_to_cart",
        description: "Add products to the shopping cart using product IDs",
        schema: z.object({
            productIds: z.array(z.string()).describe("Array of product IDs to add to cart"),
            sessionId: z.string().describe("User session ID")
        })
    }
);

/**
 * Tool: View Cart
 * Shows current cart contents from Redis
 */
export const viewCartTool = tool(
    async ({ sessionId }) => {
        console.log(`👀 Viewing cart for session: ${sessionId}`);
        
        try {
            const cartKey = `cart:${sessionId}`;
            let cart = await client.json.get(cartKey, { path: '$' });
            cart = cart ? cart[0] : [];
            
            if (cart.length === 0) {
                return "🛒 Your cart is empty! Ask me for recipe ingredients or search for products to get started.";
            }
            
            const cartItems = cart.map((item, index) => {
                const savings = item.originalPrice > item.price ? ` (Save ₹${item.originalPrice - item.price})` : '';
                return `${index + 1}. **${item.name}** - ₹${item.price} x ${item.quantity} = ₹${item.price * item.quantity}${savings}
   ${item.brand ? `Brand: ${item.brand}` : ''}`;
            }).join('\n\n');
            
            const cartTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
            
            return `🛒 **Your Shopping Cart:**

${cartItems}

💰 **Total: ₹${cartTotal}** (${totalItems} items)

Ready to checkout or need to add more items?`;
            
        } catch (error) {
            console.error('Error viewing cart:', error);
            return "Sorry, I had trouble accessing your cart. Please try again.";
        }
    },
    {
        name: "view_cart",
        description: "View current shopping cart contents",
        schema: z.object({
            sessionId: z.string().describe("User session ID")
        })
    }
);

/**
 * Tool: Clear Cart
 * Removes all items from the shopping cart
 */
export const clearCartTool = tool(
    async ({ sessionId }) => {
        console.log(`🗑️ Clearing cart for session: ${sessionId}`);
        
        try {
            const cartKey = `cart:${sessionId}`;
            await client.json.set(cartKey, '$', []);
            
            return "🗑️ **Cart cleared!** Your shopping cart is now empty. Ready to start fresh shopping?";
            
        } catch (error) {
            console.error('Error clearing cart:', error);
            return "Sorry, I had trouble clearing your cart. Please try again.";
        }
    },
    {
        name: "clear_cart",
        description: "Clear all items from the shopping cart",
        schema: z.object({
            sessionId: z.string().describe("User session ID")
        })
    }
);

/**
 * Tool: Save to Semantic Cache
 * Saves responses to semantic cache for future retrieval.
 * Agent should use this for stable information that doesn't change often.
 */
export const saveToSemanticCacheTool = tool(
    async ({ query, response, sessionId, ttlDays = 7 }) => {
        console.log(`💾 Saving to semantic cache: "${query.substring(0, 50)}..."`);
        
        try {
            if (!CONFIG.useLangCache) {
                console.log("⏭️ Semantic cache disabled");
                return "Semantic caching is currently disabled.";
            }

            const ttlMillis = ttlDays * 24 * 60 * 60 * 1000;
            
            await chatRepository.saveResponseInSemanticCache(
                sessionId,
                query,
                response,
                ttlMillis
            );
            
            console.log(`✅ Cached response for ${ttlDays} days`);
            return `Response cached successfully for future queries.`;
            
        } catch (error) {
            console.error('Error saving to semantic cache:', error);
            return "Had trouble saving to cache, but your response is still valid.";
        }
    },
    {
        name: "save_to_semantic_cache",
        description: "Save responses to semantic cache for stable information that doesn't change often (like recipe ingredients, product descriptions, general knowledge). Use after providing information worth caching.",
        schema: z.object({
            query: z.string().describe("The original user query/question"),
            response: z.string().describe("The complete response to cache"),
            sessionId: z.string().describe("User session ID"),
            ttlDays: z.number().optional().describe("Cache duration in days (default: 7)")
        })
    }
);

export const groceryTools = [
    directAnswerTool,
    searchProductsTool,
    addToCartTool,
    viewCartTool,
    clearCartTool,
    saveToSemanticCacheTool
];
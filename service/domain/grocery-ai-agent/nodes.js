// service/domain/ai-agent/grocery-nodes.js
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage } from "@langchain/core/messages";
import { groceryTools } from "./grocery-tools.js";
import ChatRepository from "../../data/chat-repository.js";
import CONFIG from "../../../config.js";

const chatRepository = new ChatRepository();

/**
 * Grocery Shopping Agent Node
 * 
 * Specialized agent that helps users with grocery shopping by choosing appropriate tools:
 * - directAnswerTool: For general cooking/grocery knowledge
 * - searchProductsTool: To find actual products in the database
 * - Cart management tools: add/view/clear cart
 * - saveToSemanticCacheTool: To cache stable responses
 */
export const groceryShoppingAgent = async (state) => {
    const model = new ChatOpenAI({ 
        temperature: 0.2, 
        model: CONFIG.modelName, 
        apiKey: CONFIG.openAiApiKey 
    });

    // System prompt for grocery shopping context
    const systemPrompt = `You are a helpful grocery shopping assistant. You have access to several tools to help users:

🧠 **directAnswerTool**: Use this for general grocery, cooking, and food knowledge questions:
- Recipe ingredients ("What do I need for paneer tikka?")
- Cooking tips and methods
- Food storage and nutrition advice
- General culinary knowledge

🔍 **searchProductsTool**: Use this to find actual products in the database:
- When user wants to buy specific items
- After providing recipe ingredients with directAnswerTool
- For product searches and comparisons

🛒 **Cart Tools**: For cart management:
- addToCartTool: Add products using product IDs only
- viewCartTool: Show cart contents  
- clearCartTool: Empty the cart

💾 **saveToSemanticCacheTool**: Use this AFTER providing stable information:
- Recipe ingredient lists
- General food knowledge that doesn't change
- Product descriptions and information
- NOT for cart operations or dynamic searches

**Workflow for "What ingredients for idli?":**
1. Use directAnswerTool to get ingredient list from knowledge
2. Use searchProductsTool to find actual products for those ingredients  
3. Use saveToSemanticCacheTool to cache the complete response
4. Present formatted results with product IDs

**Key Guidelines:**
- Always show product IDs clearly in search results
- Use exact format: "add to cart [product IDs]"
- Remember user's session ID: ${state.sessionId}
- Cache stable responses but NOT cart operations
- Combine tools effectively for complete shopping assistance

Be helpful and guide users through their grocery shopping journey!`;

    const modelWithTools = model.bindTools(groceryTools);

    try {
        let currentMessages = [
            { role: "system", content: systemPrompt },
            ...state.messages
        ];
        let toolUsed = "none";
        let foundProducts = [];
        
        while (true) {
            const response = await modelWithTools.invoke(currentMessages);
            currentMessages.push(response);

            if (!response.tool_calls || response.tool_calls.length === 0) {
                console.log("🛒 Grocery agent provided direct response");
                return {
                    result: response.content,
                    messages: [...state.messages, new AIMessage(response.content)],
                    toolUsed,
                    foundProducts,
                    sessionId: state.sessionId
                };
            }

            for (const toolCall of response.tool_calls) {
                let toolResult;
                
                console.log(`🔧 Grocery agent using tool: ${toolCall.name}`);
                toolUsed = toolCall.name;

                // Find and invoke the appropriate tool
                const tool = groceryTools.find(t => t.name === toolCall.name);
                if (tool) {
                    // Add sessionId to tool arguments if needed
                    const toolArgs = { ...toolCall.args };
                    if (['add_to_cart', 'view_cart', 'clear_cart', 'save_to_semantic_cache'].includes(toolCall.name)) {
                        toolArgs.sessionId = state.sessionId;
                    }
                    
                    toolResult = await tool.invoke(toolArgs);
                } else {
                    toolResult = "Unknown tool requested";
                }

                currentMessages.push({
                    role: "tool",
                    content: toolResult,
                    tool_call_id: toolCall.id,
                });
            }
        }
    } catch (error) {
        console.error("❌ Grocery shopping agent error:", error);
        return {
            result: "I apologize, but I'm having trouble with grocery shopping right now. Please try asking about recipe ingredients, searching for products, or managing your cart!",
            messages: [...state.messages, new AIMessage("I apologize, but I'm having trouble with grocery shopping right now. Please try asking about recipe ingredients, searching for products, or managing your cart!")],
            toolUsed: "error",
            sessionId: state.sessionId
        };
    }
};

/**
 * Cache Check for Grocery Shopping
 * 
 * Checks semantic cache using the user's exact query as the cache key.
 * This is the main cache flow - no tool-specific caching.
 */
export const groceryCacheCheck = async (state) => {
    const lastUserMessage = state.messages.findLast(m => m.getType() === "human");
    const userQuery = lastUserMessage?.content || "";
    
    console.log(`🔍 Checking semantic cache for: "${userQuery.substring(0, 50)}..."`);
    
    if (!CONFIG.useLangCache) {
        console.log("⏭️ Semantic cache disabled");
        return { 
            cacheStatus: "miss",
            sessionId: state.sessionId
        };
    }
    
    try {
        // Use user's exact query as cache key
        const cachedResult = await chatRepository.findFromSemanticCache(state.sessionId, userQuery);
        
        if (cachedResult) {
            console.log("🎯 Semantic cache HIT - returning previous response");
            return {
                cacheStatus: "hit",
                result: cachedResult,
                messages: [...state.messages, new AIMessage(cachedResult)],
                sessionId: state.sessionId
            };
        }
        
        console.log("❌ Semantic cache MISS - proceeding to agent");
        return { 
            cacheStatus: "miss",
            sessionId: state.sessionId
        };
        
    } catch (error) {
        console.error("Error checking semantic cache:", error);
        return { 
            cacheStatus: "miss",
            sessionId: state.sessionId
        };
    }
};

/**
 * Save Grocery Results to Cache
 * 
 * Modified save function with longer TTL for ingredient lists since they don't change often.
 * But shorter TTL for price-related queries since prices can fluctuate.
 */
export const saveGroceryToCache = async (state) => {
    if (!CONFIG.useLangCache || !state.result) {
            return {};
        }
        
        const lastUserMessage = state.messages.find(m => m.getType() === "human");
        const query = lastUserMessage?.content || "";
        
        // Determine cache TTL based on query type
        const cacheTTL = 6 * 60 * 60 * 1000; // 6 hours
        
        await chatRepository.saveResponseInSemanticCache(
            state.sessionId, 
            query, 
            state.result, 
            cacheTTL
        );
        
        console.log(`💾 Saved grocery result to cache with TTL: ${cacheTTL}ms`);
        return {};
    };
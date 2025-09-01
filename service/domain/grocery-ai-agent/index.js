// service/domain/ai-agent/grocery-index.js
import { StateGraph, START, END } from "@langchain/langgraph";
import { GroceryAgentState } from "./state.js";
import { groceryCacheCheck, groceryShoppingAgent, saveGroceryToCache } from "./nodes.js";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import ChatRepository from "../../data/chat-repository.js";

const chatRepository = new ChatRepository();

/**
 * Create Grocery Shopping LangGraph Agent
 * 
 * This creates a specialized agent graph for grocery shopping with:
 * 1. Smart caching for recipe ingredient lists (long TTL) vs cart/search operations (no cache)
 * 2. Specialized grocery shopping tools with embeddings support
 * 3. Product ID-based cart management
 * 4. LLM-powered recipe ingredient knowledge + real product database
 */
export const createGroceryShoppingAgent = () => {
    const graph = new StateGraph(GroceryAgentState)
        .addNode("grocery_cache_check", groceryCacheCheck)
        .addNode("grocery_shopping_agent", groceryShoppingAgent)
        .addNode("save_grocery_cache", saveGroceryToCache)
        
        .addEdge(START, "grocery_cache_check")
        .addConditionalEdges("grocery_cache_check", (state) => {
            return state.cacheStatus === "hit" ? END : "grocery_shopping_agent";
        })
        .addEdge("grocery_shopping_agent", "save_grocery_cache")
        .addEdge("save_grocery_cache", END)
        
        .compile();
    
    return graph;
};

export const groceryGraph = createGroceryShoppingAgent();

export function getGroceryExecutionSummary(graphResult) {
    const summary = {
        toolUsed: graphResult.toolUsed || "none",
        cacheStatus: graphResult.cacheStatus || "miss",
        finalResult: graphResult.result,
        sessionId: graphResult.sessionId,
        productsFound: graphResult.foundProducts?.length || 0
    };
    
    console.log("\n🛒 GROCERY SHOPPING EXECUTION SUMMARY:");
    console.log(`Session: ${summary.sessionId}`);
    console.log(`Cache: ${summary.cacheStatus === "hit" ? "🎯 HIT" : "❌ MISS"}`);
    
    let toolIcon = "🧠 Direct Response";
    if (summary.toolUsed === "get_recipe_ingredients") toolIcon = "🥘 Recipe Ingredients";
    else if (summary.toolUsed === "search_products") toolIcon = "🔍 Product Search";
    else if (summary.toolUsed === "semantic_search") toolIcon = "🧠 Semantic Search";
    else if (summary.toolUsed === "add_to_cart") toolIcon = "🛒 Add to Cart";
    else if (summary.toolUsed === "view_cart") toolIcon = "👀 View Cart";
    else if (summary.toolUsed === "clear_cart") toolIcon = "🗑️ Clear Cart";
    else if (summary.toolUsed !== "none") toolIcon = `🔧 ${summary.toolUsed}`;
    
    console.log(`Tool Used: ${toolIcon}`);
    if (summary.productsFound > 0) {
        console.log(`Products Found: ${summary.productsFound}`);
    }
    console.log("─".repeat(50));
    
    return summary;
}

/**
 * Main function to get grocery shopping reply
 * This replaces the getReplyFromAgent function in your chat service
 */
export async function getGroceryShoppingReply(sessionId, chatId, message, useSmartRecall) {
    try {
        const rawHistory = await chatRepository.getOrCreateChatHistory(sessionId, chatId);

        // Convert raw history to LangChain message format
        const messages = rawHistory.map((msg) => {
            return msg.role === "user"
                ? new HumanMessage(msg.content)
                : new AIMessage(msg.content);
        });

        // Add the new user message
        const userMessage = new HumanMessage(message);
        messages.push(userMessage);

        // Run the grocery shopping graph
        const result = await groceryGraph.invoke({
            sessionId,
            messages,
        });

        // Get execution summary for logging
        const executionSummary = getGroceryExecutionSummary(result);

        const finalReply = result.result || result.output;

        const queryResult = {
            isCachedResponse: result.cacheStatus === "hit",
            content: finalReply,
        };

        // Save messages back to storage
        await chatRepository.saveChatMessage(sessionId, chatId, {
            role: "user",
            content: message,
        });

        await chatRepository.saveChatMessage(sessionId, chatId, {
            role: "assistant",
            content: finalReply,
        });

        return queryResult;
        
    } catch (error) {
        console.error("❌ Error in grocery shopping reply:", error);
        
        // Return fallback response
        return {
            isCachedResponse: false,
            content: "I apologize, but I'm having trouble processing your grocery request right now. Please try asking about recipe ingredients, searching for products, or managing your cart."
        };
    }
}
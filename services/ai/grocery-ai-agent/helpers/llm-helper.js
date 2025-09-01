// ai/grocery-ai-agent/helpers/llm-helper.js
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import CONFIG from '../../../../config.js';

/**
 * Get ingredients from LLM for a recipe
 * @param {string} recipe - Recipe name
 * @returns {Promise<Object>} Parsed ingredients data
 */
export async function getIngredientsFromLLM(recipe) {
    const model = new ChatOpenAI({ 
        temperature: 0.2, 
        model: CONFIG.modelName, 
        apiKey: CONFIG.openAiApiKey 
    });
    
    const systemPrompt = `You are a cooking expert. For the given recipe, provide a simple JSON response with the essential ingredients needed.

Return only a JSON object with this structure:
{
  "recipe": "recipe name",
  "ingredients": [
    { "name": "ingredient name", "quantity": "amount needed", "essential": true/false },
    ...
  ]
}

Focus on the core ingredients only. Mark ingredients as "essential: true" for must-have items, "essential: false" for optional ones.
Keep ingredient names simple and searchable (e.g., "onions" not "medium-sized yellow onions").
Don't include basic items like salt, water unless they're special (like sea salt).`;

    const response = await model.invoke([
        { role: "system", content: systemPrompt },
        new HumanMessage(`What ingredients do I need for: ${recipe}`)
    ]);
    
    // Parse the LLM response to get ingredients
    try {
        return JSON.parse(response.content);
    } catch (parseError) {
        throw new Error("Could not parse recipe ingredients. Please try rephrasing your recipe request.");
    }
}

/**
 * Get direct answer from LLM for general questions
 * @param {string} question - User question
 * @returns {Promise<string>} LLM response
 */
export async function getDirectAnswerFromLLM(question) {
    const model = new ChatOpenAI({ 
        temperature: 0.2, 
        model: CONFIG.modelName, 
        apiKey: CONFIG.openAiApiKey 
    });
    
    const systemPrompt = `You are a knowledgeable grocery shopping and cooking assistant. Answer questions about:
- Cooking methods and techniques
- Food storage and preparation tips  
- Nutritional information and health benefits
- Spices, seasonings, and flavor combinations
- Grocery shopping advice and tips
- Indian cuisine and cooking techniques

Provide helpful, accurate information based on your knowledge. Keep responses concise and practical.
Do not mention specific product prices or brands - focus on general knowledge and advice.`;

    const response = await model.invoke([
        { role: "system", content: systemPrompt },
        new HumanMessage(question)
    ]);
    
    return response.content;
}
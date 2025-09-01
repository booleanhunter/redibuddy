// services/products/domain/product-service.js
import ProductRepository from '../data/product-repository.js';

const productRepository = new ProductRepository();

/**
 * Find products using semantic search
 * @param {string} query - Search query
 * @param {number} limit - Maximum number of results
 * @param {number} threshold - Similarity threshold
 * @returns {Promise<Array>} Array of products
 */
export async function findProductsBySemanticSearch(query, limit = 8, threshold = 0.6) {
    try {
        const products = await productRepository.semanticSearchProducts(query, limit, threshold);
        return products;
    } catch (error) {
        console.error('Error in semantic search:', error);
        throw error;
    }
}

/**
 * Search products with various filters
 * @param {Object} searchParams - Search parameters
 * @param {string} searchParams.query - Search query
 * @param {string} searchParams.category - Category filter
 * @param {number} searchParams.maxPrice - Maximum price filter
 * @param {number} searchParams.minRating - Minimum rating filter
 * @param {number} searchParams.limit - Maximum results
 * @param {boolean} searchParams.useSemanticSearch - Use semantic search
 * @returns {Promise<Array>} Array of products with metadata
 */
export async function searchProducts({ query, category, maxPrice, minRating, limit = 8, useSemanticSearch = true }) {
    try {
        const products = await productRepository.searchProducts({ 
            query, 
            category, 
            maxPrice, 
            minRating, 
            limit,
            useSemanticSearch
        });

        // Structure the product data with navigation links
        const structuredProducts = products.map(product => ({
            id: product.id,
            name: product.name,
            brand: product.brand || 'Generic',
            category: product.category,
            salePrice: product.salePrice,
            marketPrice: product.marketPrice,
            discount: product.discount || 0,
            rating: product.rating || 0,
            description: product.description ? product.description.substring(0, 100) : '',
            semanticScore: product.semanticScore || null,
            isOnSale: product.isOnSale || false,
            productUrl: `/product/${product.id}` // Add navigation URL
        }));

        const totalCost = structuredProducts.reduce((sum, product) => sum + product.salePrice, 0);

        return {
            products: structuredProducts,
            totalFound: structuredProducts.length,
            totalCost,
            searchType: useSemanticSearch ? "semantic" : "keyword"
        };
    } catch (error) {
        console.error('Error searching products:', error);
        throw error;
    }
}

/**
 * Get ingredients for a recipe with product suggestions
 * @param {string} recipe - Recipe name
 * @param {Function} getIngredientsFromLLM - Function to get ingredients from LLM
 * @returns {Promise<Object>} Recipe ingredients with product suggestions
 */
export async function getRecipeIngredientsWithProducts(recipe, getIngredientsFromLLM) {
    try {
        // Get ingredients from LLM
        const ingredientsData = await getIngredientsFromLLM(recipe);
        
        if (!ingredientsData.ingredients) {
            throw new Error('No ingredients received from LLM');
        }

        // For each essential ingredient, find ONE good product quickly
        const ingredientProducts = [];
        const essentialIngredients = ingredientsData.ingredients.filter(ing => ing.essential);
        
        for (const ingredient of essentialIngredients.slice(0, 6)) { // Limit to 6 ingredients
            try {
                // Quick semantic search with limit 1 for speed
                const products = await findProductsBySemanticSearch(ingredient.name, 1, 0.6);
                
                if (products.length > 0) {
                    const product = products[0];
                    console.log(`Found product: ${product.name} ${product.id}`);

                    ingredientProducts.push({
                        ingredient: ingredient.name,
                        quantity: ingredient.quantity,
                        suggestedProduct: {
                            id: product.id,
                            name: product.name,
                            brand: product.brand || 'Generic',
                            price: product.salePrice,
                            category: product.category
                        }
                    });
                } else {
                    // No product found, just list the ingredient
                    ingredientProducts.push({
                        ingredient: ingredient.name,
                        quantity: ingredient.quantity,
                        suggestedProduct: null
                    });
                }
            } catch (searchError) {
                console.warn(`Could not search for ${ingredient.name}:`, searchError);
                // Continue with other ingredients
                ingredientProducts.push({
                    ingredient: ingredient.name,
                    quantity: ingredient.quantity,
                    suggestedProduct: null
                });
            }
        }
        
        return {
            recipe: ingredientsData.recipe || recipe,
            totalIngredients: essentialIngredients.length,
            ingredientProducts: ingredientProducts,
            message: "Here are the essential ingredients with quick product suggestions!"
        };
        
    } catch (error) {
        console.error('Error getting recipe ingredients with products:', error);
        throw error;
    }
}

/**
 * Get product by ID
 * @param {string} productId - Product ID
 * @returns {Promise<Object|null>} Product or null if not found
 */
export async function getProductById(productId) {
    try {
        return await productRepository.getProductById(productId);
    } catch (error) {
        console.error('Error getting product by ID:', error);
        throw error;
    }
}
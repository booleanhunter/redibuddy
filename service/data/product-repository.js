import { createClient } from 'redis';
import { LangCache } from "@redis-ai/langcache";

import CONFIG from '../../config.js';
import { generateEmbeddings } from '../domain/helpers.js';

const client = await createClient({
    url: CONFIG.redisUrl,
}).on('error', (err) => console.log('Redis Client Error', err))
  .connect();

/** @type {LangCache|null} */
let langCache = null;

if (CONFIG.useLangCache) {
    langCache = new LangCache({
        serverURL: CONFIG.langcacheApiBaseUrl,
        cacheId: CONFIG.langcacheCacheId,
        apiKey: CONFIG.langcacheApiKey,
    });
}

export default class ProductRepository {

    /**
     * Semantic search using embeddings
     * @param {string} query - Natural language search query
     * @param {number} limit - Number of results to return
     * @param {number} threshold - Similarity threshold (0-1, default: 0.7)
     */
    async semanticSearchProducts(query, limit = 10, threshold = 0.7) {
        try {
            console.log(`🧠 Semantic search for: "${query}"`);
            
            // Generate embedding for the search query
            const queryEmbedding = await generateEmbeddings([query]);
            const searchVector = queryEmbedding[0];
            
            // Get all product embeddings (in production, you'd use a vector database like Redis Vector)
            // For now, we'll do a simple cosine similarity search
            const embeddingKeys = await client.keys('embedding:*');
            const similarities = [];
            
            console.log(`🔍 Comparing against ${embeddingKeys.length} product embeddings...`);
            
            for (const key of embeddingKeys.slice(0, 200)) { // Limit to prevent timeout
                try {
                    const embeddingData = await client.json.get(key, { path: '$' });
                    if (embeddingData && embeddingData[0]) {
                        const productEmbedding = embeddingData[0].embedding;
                        const similarity = cosineSimilarity(searchVector, productEmbedding);
                        
                        if (similarity >= threshold) {
                            similarities.push({
                                productId: embeddingData[0].productId,
                                similarity,
                                text: embeddingData[0].text
                            });
                        }
                    }
                } catch (err) {
                    continue; // Skip invalid embeddings
                }
            }
            
            // Sort by similarity and get top results
            similarities.sort((a, b) => b.similarity - a.similarity);
            const topMatches = similarities.slice(0, limit);
            
            console.log(`✅ Found ${topMatches.length} semantic matches`);
            
            // Fetch full product details
            const products = [];
            for (const match of topMatches) {
                try {
                    const product = await client.json.get(`product:${match.productId}`, { path: '$' });
                    if (product && product[0]) {
                        products.push({
                            ...product[0],
                            semanticScore: match.similarity
                        });
                    }
                } catch (err) {
                    continue;
                }
            }
            
            return products;
            
        } catch (error) {
            console.error('❌ Error in semantic search:', error);
            return [];
        }
    }

    /**
     * Calculate cosine similarity between two vectors
     * @param {number[]} a - First vector
     * @param {number[]} b - Second vector
     * @returns {number} Similarity score (0-1)
     */
    cosineSimilarity(a, b) {
        const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
        const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
        const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
        
        return dotProduct / (magnitudeA * magnitudeB);
    }

    /**
     * Enhanced product search that combines keyword and semantic search
     * @param {Object} criteria - Search criteria
     */
    async searchProducts(criteria = {}) {
        const { query, category, limit = 10, useSemanticSearch = true } = criteria;
        
        try {
            let products = [];
            
            // Try semantic search first if query provided
            if (query && useSemanticSearch) {
                console.log('🧠 Using semantic search...');
                products = await this.semanticSearchProducts(query, limit * 2, 0.6); // Lower threshold, get more results
            }
            
            // Fallback to keyword search if semantic search returns few results
            if (products.length < 3 && query) {
                console.log('🔍 Supplementing with keyword search...');
                const keywordResults = await this.keywordSearchProducts({ query, category, limit });
                
                // Merge results, avoiding duplicates
                keywordResults.forEach(product => {
                    if (!products.find(p => p.id === product.id)) {
                        products.push(product);
                    }
                });
            }
            
            // Category filter
            if (category) {
                products = products.filter(p => 
                    p.category.toLowerCase().includes(category.toLowerCase())
                );
            }
            
            // Sort by relevance (semantic score or rating)
            products.sort((a, b) => {
                if (a.semanticScore && b.semanticScore) {
                    return b.semanticScore - a.semanticScore;
                }
                return (b.rating || 0) - (a.rating || 0);
            });
            
            return products.slice(0, limit);
            
        } catch (error) {
            console.error('❌ Error in enhanced product search:', error);
            // Fallback to basic keyword search
            return await this.keywordSearchProducts(criteria);
        }
    }

    /**
     * Traditional keyword-based product search (fallback)
     */
    async keywordSearchProducts(criteria = {}) {
        const { query, category, limit = 20 } = criteria;
        
        try {
            let productIds = new Set();
            
            if (query) {
                const searchTerm = query.toLowerCase().split(/\s+/)[0];
                if (searchTerm.length > 2) {
                    const ids = await client.sMembers(`search:${searchTerm}`);
                    productIds = new Set(ids.slice(0, limit * 2));
                }
            }
            
            if (category) {
                const categoryIds = await client.sMembers(`category:${category.toLowerCase()}`);
                if (productIds.size === 0) {
                    productIds = new Set(categoryIds.slice(0, limit * 2));
                } else {
                    productIds = new Set([...productIds].filter(id => categoryIds.includes(id)));
                }
            }
            
            // If no criteria, get random sample
            if (productIds.size === 0) {
                const sampleKeys = await client.keys('product:*');
                const randomSample = sampleKeys.sort(() => 0.5 - Math.random()).slice(0, limit);
                productIds = new Set(randomSample.map(key => key.replace('product:', '')));
            }
            
            // Fetch products
            const products = [];
            const productIdsArray = [...productIds].slice(0, limit);
            
            for (const id of productIdsArray) {
                try {
                    const product = await client.json.get(`product:${id}`, { path: '$' });
                    if (product && product[0]) {
                        products.push(product[0]);
                    }
                } catch (err) {
                    continue;
                }
            }
            
            return products;
            
        } catch (error) {
            console.error('❌ Error in keyword search:', error);
            return [];
        }
    }
}

// service/data/product-loader-optimized.js
import { createClient, SCHEMA_FIELD_TYPE, FT_AGGREGATE_GROUP_BY_REDUCERS, FT_AGGREGATE_STEPS } from 'redis';

import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import CONFIG from '../../config.js';

import OpenAI from 'openai';

import { generateEmbeddings } from '../domain/helpers.js';

const client = await createClient({
    url: CONFIG.redisUrl,
}).on('error', (err) => console.log('Redis Client Error', err))
  .connect();

const openai = new OpenAI({
    apiKey: CONFIG.openAiApiKey,
})

try {
	await client.ft.create('idx:products', {
		'$.name': {
			type: SCHEMA_FIELD_TYPE.TEXT,
			SORTABLE: true
		},
		'$.description': {
			type: SCHEMA_FIELD_TYPE.TEXT,
			AS: 'description'
		},
	}, {
		ON: 'JSON',
		PREFIX: 'noderedis:products'
	});
	} catch (e) {
	if (e.message === 'Index already exists') {
		console.log('Index exists already, skipped creation.');
	} else {
		// Something went wrong, perhaps RediSearch isn't installed...
		console.error(e);
		process.exit(1);
	}
}

/**
 * Memory-optimized product loader that processes data in smaller batches
 * @param {string} csvFilePath - Path to the CSV file
 * @param {number} batchSize - Number of products to process at once (default: 100)
 * @param {number} maxProducts - Maximum number of products to load (default: 1000)
 */
export async function loadProductsFromCSV(csvFilePath, batchSize = 100, maxProducts = 1000) {
    try {
        console.log('📋 Reading CSV file:', csvFilePath);
        
        // Read and parse CSV file
        const csvData = readFileSync(csvFilePath, 'utf-8');
        const records = parse(csvData, {
            columns: true,
            skip_empty_lines: true,
            trim: true
        });

        console.log(`📦 Found ${records.length} total products in CSV`);
        // console.log(`✅ After filtering: ${products.length} grocery products (excluded non-grocery categories)`);
        //console.log(`🎯 Will load maximum ${Math.min(products.length, maxProducts)} products in batches of ${batchSize}`);

        // Categories to skip (non-grocery items)
        const EXCLUDED_CATEGORIES = [
            'Beauty & Hygiene',
            'Cleaning & Household', 
            'Baby Care'
        ];

        console.log(`🚫 Excluding categories: ${EXCLUDED_CATEGORIES.join(', ')}`);

        // Clean and process products (filter out excluded categories)
        const products = records
            .filter(record => {
                // Filter out empty products
                if (!record.product || !record.product.trim()) {
                    return false;
                }
                
                // Filter out excluded categories
                const category = record.category?.trim() || '';
                if (EXCLUDED_CATEGORIES.includes(category)) {
                    return false;
                }
                
                return true;
            })
            .slice(0, maxProducts) // Limit number of products
            .map(record => ({
                id: record.index || generateId(),
                name: record.product?.trim(),
                category: record.category?.trim() || 'Uncategorized',
                subCategory: record.sub_category?.trim() || '',
                brand: record.brand?.trim() || '',
                salePrice: parseFloat(record.sale_price) || 0,
                marketPrice: parseFloat(record.market_price) || 0,
                type: record.type?.trim() || '',
                rating: parseFloat(record.rating) || 0,
                description: record.description?.trim().substring(0, 200) || '', // Limit description length
                discount: record.market_price && record.sale_price ? 
                    Math.round(((parseFloat(record.market_price) - parseFloat(record.sale_price)) / parseFloat(record.market_price)) * 100) : 0,
                isOnSale: record.market_price && record.sale_price && parseFloat(record.market_price) > parseFloat(record.sale_price)
            }));

        console.log(`✅ Processing ${products.length} products in batches...`);

        // Clear existing data first (optional)
        console.log('🧹 Clearing existing product data...');
        const existingKeys = await client.keys('product:*');
        if (existingKeys.length > 0) {
            await client.del(...existingKeys.slice(0, 1000)); // Delete in chunks to avoid memory issues
        }

        // Process products in batches
        let totalProcessed = 0;
        const categories = new Set();
        const brands = new Set();
        
        for (let i = 0; i < products.length; i += batchSize) {
            const batch = products.slice(i, i + batchSize);
            console.log(`📤 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(products.length/batchSize)} (${batch.length} items)`);
            
            const pipeline = client.multi();

            
            
            for (const product of batch) {

                const textsForEmbedding =`${product.name} ${product.brand} ${product.type} ${product.description.substring(0, 200)}`.replace(/\s+/g, ' ').trim();
                
                const embeddings = await generateEmbeddings(textsForEmbedding);
                // Store individual product with minimal data
                const minimalProduct = {
                    id: product.id,
                    name: product.name,
                    category: product.category,
                    brand: product.brand,
                    salePrice: product.salePrice,
                    rating: product.rating,
                    description: product.description.substring(0, 100), // Further limit description
                    productInfoEmbeddings: embeddings,
                };
                
                pipeline.json.set(`noderedis:products:${product.id}`, '$', minimalProduct);
                
                
            }
            
            try {
                await pipeline.exec();
                totalProcessed += batch.length;
                console.log(`✅ Batch completed. Total processed: ${totalProcessed}`);
                
                // Add small delay to prevent overwhelming Redis
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error) {
                console.error(`❌ Error processing batch starting at index ${i}:`, error);
                // Continue with next batch instead of failing completely
                continue;
            }
        }

        // Store minimal metadata
        await client.json.set('products:metadata', '$', {
            totalProducts: totalProcessed,
            categoriesCount: categories.size,
            brandsCount: brands.size,
            loadedAt: new Date().toISOString(),
            limitedTo: maxProducts
        });

        console.log('🎉 Products successfully loaded into Redis!');
        console.log(`📊 Final Statistics:`);
        console.log(`   - Products loaded: ${totalProcessed}`);
        console.log(`   - Categories: ${categories.size}`);
        console.log(`   - Brands: ${brands.size}`);
        
        return {
            success: true,
            productsLoaded: totalProcessed,
            categories: categories.size,
            brands: brands.size
        };

    } catch (error) {
        console.error('❌ Error loading products:', error);
        throw error;
    }
}

/**
 * Check Redis memory usage before loading
 */
export async function checkRedisMemory() {
    try {
        const info = await client.info('memory');
        const lines = info.split('\r\n');
        const memoryInfo = {};
        
        lines.forEach(line => {
            const [key, value] = line.split(':');
            if (key && value) {
                memoryInfo[key] = value;
            }
        });
        
        console.log('🧠 Redis Memory Info:');
        console.log(`   Used Memory: ${memoryInfo.used_memory_human || 'Unknown'}`);
        console.log(`   Max Memory: ${memoryInfo.maxmemory_human || 'Unlimited'}`);
        
        return memoryInfo;
    } catch (error) {
        console.error('Error checking Redis memory:', error);
        return null;
    }
}

function generateId() {
    return Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}


import dotenv from 'dotenv';
dotenv.config();

if (!process.env.OPENAI_API_KEY) {
    console.warn('Warning: OPENAI_API_KEY is not defined in environment variables.');
}

const CONFIG = {
    serverPort: process.env.SERVER_PORT || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    openAiApiKey: process.env.OPENAI_API_KEY,
};

export default CONFIG;

import { Router } from 'express';
import { getReplyFromLLM, endSession } from '../../domain/chat.js';

const router = Router();

/* GET home page. */
// POST /chat
router.post('/chat', async function(req, res, next) {
	const { message, sessionId, chatId, memoryEnabled } = req.body;

	if (!message || !sessionId) {
		return res.status(400).json({ error: 'Missing message or sessionId' });
	}

	try {
		const reply = await getReplyFromLLM(sessionId, chatId, message, memoryEnabled);
		res.json({ reply });
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: 'Something went wrong.' });
	}
});

router.post('/chat/end-session', async function(req, res, next) {
	const { sessionId } = req.body;

	if (!sessionId) {
		return res.status(400).json({ error: 'Missing sessionId' });
	}

	try {
		const result = await endSession(sessionId);
		res.json(result);
	} catch (error) {
		console.log(error.stack);
		res.status(500).json({ error: 'Something went wrong.' });
	}
});

export default router;

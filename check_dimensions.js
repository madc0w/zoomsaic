const sharp = require('sharp');
const fs = require('fs');

(async () => {
	try {
		const files = fs
			.readdirSync('.')
			.filter((f) => f.startsWith('zoomsaic_') && f.endsWith('.png'))
			.sort();

		console.log('Frame dimensions:');
		for (const file of files) {
			const meta = await sharp(file).metadata();
			console.log(`${file}: ${meta.width} x ${meta.height}`);
		}
	} catch (error) {
		console.error('Error:', error.message);
	}
})();

const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
// const Jimp = require('jimp');

const defaultTileSize = 64;
const defaultMosaicWidth = 120;

class MosaicGenerator {
	constructor() {
		this.tileCache = new Map();
		this.tileSize = defaultTileSize; // Size of each mosaic tile
	}

	// Get all image files from directory and subdirectories
	async getImageFiles(dir) {
		const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
		const files = [];

		async function scanDirectory(currentDir) {
			try {
				const items = await fs.readdir(currentDir);

				for (const item of items) {
					const fullPath = path.join(currentDir, item);
					const stat = await fs.stat(fullPath);

					if (stat.isDirectory()) {
						await scanDirectory(fullPath);
					} else if (
						imageExtensions.includes(path.extname(item).toLowerCase())
					) {
						files.push(fullPath);
					}
				}
			} catch (error) {
				console.warn(
					`Warning: Could not read directory ${currentDir}: ${error.message}`
				);
			}
		}

		await scanDirectory(dir);
		return files;
	}

	// Calculate average color of an image
	async getAverageColor(imagePath) {
		if (this.tileCache.has(imagePath)) {
			return this.tileCache.get(imagePath);
		}

		try {
			// Resize image to tile size and get raw pixel data
			const { data, info } = await sharp(imagePath)
				.resize(this.tileSize, this.tileSize)
				.raw()
				.toBuffer({ resolveWithObject: true });

			let r = 0,
				g = 0,
				b = 0;
			const pixelCount = data.length / 3;

			// Calculate average RGB values
			for (let i = 0; i < data.length; i += 3) {
				r += data[i];
				g += data[i + 1];
				b += data[i + 2];
			}

			const avgColor = {
				r: Math.round(r / pixelCount),
				g: Math.round(g / pixelCount),
				b: Math.round(b / pixelCount),
				path: imagePath,
			};

			this.tileCache.set(imagePath, avgColor);
			return avgColor;
		} catch (error) {
			console.warn(
				`Warning: Could not process image ${imagePath}: ${error.message}`
			);
			return null;
		}
	}

	// Calculate color distance between two colors
	colorDistanceSq(color1, color2) {
		const dr = color1.r - color2.r;
		const dg = color1.g - color2.g;
		const db = color1.b - color2.b;
		return dr * dr + dg * dg + db * db;
	}

	// Find the best matching tile for a given color
	findBestTile(targetColor, tiles) {
		let bestTile = tiles[0];
		let bestDistance = this.colorDistanceSq(targetColor, bestTile);

		for (let i = 1; i < tiles.length; i++) {
			const distance = this.colorDistanceSq(targetColor, tiles[i]);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestTile = tiles[i];
			}
		}

		return bestTile;
	}

	// Load tile cache from CSV file
	async loadTileCacheFromCSV(cacheFilePath) {
		try {
			const csvData = await fs.readFile(cacheFilePath, 'utf-8');
			const lines = csvData.trim().split('\n');
			const tiles = [];

			// Skip header line
			for (let i = 1; i < lines.length; i++) {
				const [path, r, g, b] = lines[i].split(',');
				if (path && r && g && b) {
					const tileData = {
						path: path.trim(),
						r: parseInt(r.trim()),
						g: parseInt(g.trim()),
						b: parseInt(b.trim()),
					};
					tiles.push(tileData);
					this.tileCache.set(tileData.path, tileData);
				}
			}

			return tiles;
		} catch (error) {
			// Cache file doesn't exist or is invalid
			return null;
		}
	}

	// Save tile cache to CSV file
	async saveTileCacheToCSV(tiles, cacheFilePath) {
		try {
			const csvLines = ['path,r,g,b'];
			for (const tile of tiles) {
				csvLines.push(`${tile.path},${tile.r},${tile.g},${tile.b}`);
			}
			await fs.writeFile(cacheFilePath, csvLines.join('\n'), 'utf-8');
			console.log(`Tile cache saved to ${cacheFilePath}`);
		} catch (error) {
			console.warn(`Warning: Could not save cache file: ${error.message}`);
		}
	}

	// Generate the mosaic
	async generateMosaic(
		inputImagePath,
		tilesDirectory,
		outputPath,
		options = {}
	) {
		const {
			mosaicWidth = defaultMosaicWidth, // Number of tiles horizontally
			mosaicHeight = null, // Number of tiles vertically (auto if null)
			tileSize = defaultTileSize, // Size of each tile in pixels
			allowReuse = true, // Allow tiles to be reused
		} = options;

		this.tileSize = tileSize;

		console.log('Loading input image...');
		const inputMetadata = await sharp(inputImagePath).metadata();

		// Try to load cached tile data first
		const cacheFilePath = path.join(tilesDirectory, 'tiles.csv');
		console.log('Checking for tile cache...');
		let tiles = await this.loadTileCacheFromCSV(cacheFilePath);
		let tileFiles = [];

		if (tiles) {
			console.log(`Loaded ${tiles.length} tiles from cache`);
			// Get tile files from cache instead of scanning directory
			tileFiles = tiles.map((tile) => tile.path);
			// console.log('Checking for new tile images...');
			// const allTileFiles = await this.getImageFiles(tilesDirectory);
			// const cachedPaths = new Set(tileFiles);
			// const newTileFiles = allTileFiles.filter(
			// 	(file) => !cachedPaths.has(file)
			// );

			// if (newTileFiles.length > 0) {
			// 	console.log(`Found ${newTileFiles.length} new tile images`);
			// 	tileFiles = allTileFiles; // Use all files for processing
			// } else {
			// 	console.log('No new tiles found');
			// }
		} else {
			// No cache exists, need to scan all files
			console.log('Scanning for tile images...');
			tileFiles = await this.getImageFiles(tilesDirectory);

			if (tileFiles.length === 0) {
				throw new Error(`No image files found in ${tilesDirectory}`);
			}

			console.log(`Found ${tileFiles.length} tile images`);
		}

		if (tiles) {
			// Check if we have new files not in cache
			const cachedPaths = new Set(tiles.map((tile) => tile.path));
			const newTileFiles = tileFiles.filter((file) => !cachedPaths.has(file));

			if (newTileFiles.length > 0) {
				console.log(`Processing ${newTileFiles.length} new tile images...`);
				let processed = 0;

				for (const tileFile of newTileFiles) {
					const tileData = await this.getAverageColor(tileFile);
					if (tileData) {
						tiles.push(tileData);
					}
					processed++;
					if (processed % 50 === 0) {
						console.log(
							`Processed ${processed}/${newTileFiles.length} new tiles`
						);
					}
				}

				// Save updated cache
				await this.saveTileCacheToCSV(tiles, cacheFilePath);
			} else {
				console.log('No new tiles to process');
			}
		} else {
			console.log('No cache found. Processing all tile images...');
			tiles = [];
			let processed = 0;

			for (const tileFile of tileFiles) {
				const tileData = await this.getAverageColor(tileFile);
				if (tileData) {
					tiles.push(tileData);
				}
				processed++;
				if (processed % 50 === 0) {
					console.log(`Processed ${processed}/${tileFiles.length} tiles`);
				}
			}

			// Save cache for next time
			await this.saveTileCacheToCSV(tiles, cacheFilePath);
		}

		if (tiles.length === 0) {
			throw new Error('No valid tile images could be processed');
		}

		console.log(`Processed ${tiles.length} valid tiles`);

		// Calculate mosaic dimensions
		const aspectRatio = inputMetadata.height / inputMetadata.width;
		const finalMosaicHeight =
			mosaicHeight || Math.round(mosaicWidth * aspectRatio);

		// Resize input image to mosaic grid size for color analysis
		console.log('Analyzing input image colors...');
		const { data: inputData } = await sharp(inputImagePath)
			.resize(mosaicWidth, finalMosaicHeight)
			.raw()
			.toBuffer({ resolveWithObject: true });

		console.log(`Generating ${mosaicWidth}x${finalMosaicHeight} mosaic...`);

		const usedTiles = new Set();
		const tileImages = [];

		// Generate mosaic tile by tile
		for (let y = 0; y < finalMosaicHeight; y++) {
			const row = [];
			for (let x = 0; x < mosaicWidth; x++) {
				// Get color of this pixel in the scaled input image
				const pixelIndex = (y * mosaicWidth + x) * 3;
				const targetColor = {
					r: inputData[pixelIndex],
					g: inputData[pixelIndex + 1],
					b: inputData[pixelIndex + 2],
				};

				// Find best matching tile
				let availableTiles = tiles;
				if (!allowReuse) {
					availableTiles = tiles.filter((tile) => !usedTiles.has(tile));
					if (availableTiles.length === 0) {
						availableTiles = tiles; // Fallback to all tiles if we run out
					}
				}

				const bestTile = this.findBestTile(targetColor, availableTiles);

				if (!allowReuse) {
					usedTiles.add(bestTile);
				}

				row.push(bestTile.path);
			}
			tileImages.push(row);

			// Progress indicator
			if ((y + 1) % 10 === 0 || y === finalMosaicHeight - 1) {
				console.log(
					`Progress: ${Math.round(((y + 1) / finalMosaicHeight) * 100)}%`
				);
			}
		}

		console.log(
			`Compositing final ${mosaicWidth} x ${finalMosaicHeight} mosaic...`
		);

		// Create composite operations for sharp
		const compositeOps = [];
		for (let y = 0; y < finalMosaicHeight; y++) {
			console.log(`Row ${y + 1} of ${finalMosaicHeight}`);
			for (let x = 0; x < mosaicWidth; x++) {
				const tilePath = tileImages[y][x];
				compositeOps.push({
					input: await sharp(tilePath).resize(tileSize, tileSize).toBuffer(),
					left: x * tileSize,
					top: y * tileSize,
				});
			}
		}

		// Create final mosaic using sharp composite
		const finalWidth = mosaicWidth * tileSize;
		const finalHeight = finalMosaicHeight * tileSize;

		const startTime = new Date();
		await sharp({
			create: {
				width: finalWidth,
				height: finalHeight,
				channels: 3,
				background: { r: 255, g: 255, b: 255 },
			},
		})
			.composite(compositeOps)
			.png()
			.toFile(outputPath);

		console.log(
			`Mosaic saved to: ${outputPath} in ${(
				(new Date() - startTime) /
				1000
			).toFixed(0)} secs`
		);
		console.log(`Final size: ${finalWidth}x${finalHeight} pixels`);
		console.log(
			`Tiles used: ${mosaicWidth}x${finalMosaicHeight} = ${
				mosaicWidth * finalMosaicHeight
			} total`
		);

		return {
			width: finalWidth,
			height: finalHeight,
			tilesUsed: mosaicWidth * finalMosaicHeight,
			availableTiles: tiles.length,
		};
	}
}

// CLI interface
async function main() {
	const args = process.argv.slice(2);

	if (args.length < 3) {
		console.log(
			'Usage: node main.cjs <input-image> <tiles-directory> <output-image> [options]'
		);
		console.log('');
		console.log('Options:');
		console.log(
			'  --width <number>     Number of tiles horizontally (default: 100)'
		);
		console.log(
			'  --height <number>    Number of tiles vertically (auto if not specified)'
		);
		console.log(
			'  --tile-size <number> Size of each tile in pixels (default: 32)'
		);
		console.log(
			"  --no-reuse          Don't reuse tiles (may result in lower quality)"
		);
		console.log('');
		console.log('Example:');
		console.log(
			'  node main.cjs photo.jpg ./tiles output.png --width 150 --tile-size 24'
		);
		process.exit(1);
	}

	const [inputImage, tilesDirectory, outputImage] = args;

	// Parse options
	const options = {
		mosaicWidth: defaultMosaicWidth,
		mosaicHeight: null,
		tileSize: defaultTileSize,
		allowReuse: true,
	};

	for (let i = 3; i < args.length; i++) {
		switch (args[i]) {
			case '--width':
				options.mosaicWidth = parseInt(args[++i]);
				break;
			case '--height':
				options.mosaicHeight = parseInt(args[++i]);
				break;
			case '--tile-size':
				options.tileSize = parseInt(args[++i]);
				break;
			case '--no-reuse':
				options.allowReuse = false;
				break;
		}
	}

	try {
		// Verify input files exist
		await fs.access(inputImage);
		await fs.access(tilesDirectory);

		const generator = new MosaicGenerator();
		const result = await generator.generateMosaic(
			inputImage,
			tilesDirectory,
			outputImage,
			options
		);

		console.log('\nMosaic generation completed successfully!');
		console.log(`Input: ${inputImage}`);
		console.log(`Output: ${outputImage}`);
		console.log(`Tiles directory: ${tilesDirectory}`);
	} catch (error) {
		console.error('Error:', error.message);
		process.exit(1);
	}
}

// Run if called directly
if (require.main === module) {
	main().catch(console.error);
}

module.exports = { MosaicGenerator };

const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

// // Check if FFmpeg is available
// function checkFFmpegAvailability() {
// 	return new Promise((resolve) => {
// 		exec('ffmpeg -version', (error) => {
// 			resolve(!error);
// 		});
// 	});
// }

// // Download and install FFmpeg (Windows)
// function installFFmpegWindows() {
// 	console.log('FFmpeg not found. Attempting to install...');

// 	// For Windows, we'll provide instructions since automatic installation is complex
// 	console.log('\n=== FFmpeg Installation Instructions ===');
// 	console.log(
// 		'1. Download FFmpeg from: https://ffmpeg.org/download.html#build-windows'
// 	);
// 	console.log('2. Or use chocolatey: choco install ffmpeg');
// 	console.log('3. Or use winget: winget install Gyan.FFmpeg');
// 	console.log('4. Make sure ffmpeg.exe is in your PATH');
// 	console.log('\nAlternatively, this script can try using Node.js packages...');

// 	return false;
// }

function getImageFiles(directory) {
	const supportedExtensions = [
		'.jpg',
		'.jpeg',
		'.png',
		'.bmp',
		'.tiff',
		'.gif',
	];

	try {
		const files = fs.readdirSync(directory);
		const imageFiles = files
			.filter((file) => {
				const ext = path.extname(file).toLowerCase();
				return supportedExtensions.includes(ext);
			})
			.sort(); // Sort files alphabetically for consistent ordering

		return imageFiles;
	} catch (error) {
		console.error(`Error reading directory ${directory}:`, error.message);
		process.exit(1);
	}
}

async function createVideo(imageDirectory, fps, outputFile) {
	const imageFiles = getImageFiles(imageDirectory);

	if (imageFiles.length === 0) {
		console.error('No image files found in the specified directory.');
		process.exit(1);
	}

	console.log(`Found ${imageFiles.length} image files in ${imageDirectory}`);
	console.log('First few files:', imageFiles.slice(0, 5));

	// Use the image2 demuxer approach - create symbolic links or rename files temporarily
	console.log('Creating video from image sequence...');

	// Create a temporary directory with sequentially numbered files
	const tempDir = path.join(imageDirectory, 'temp_sequence');
	if (!fs.existsSync(tempDir)) {
		fs.mkdirSync(tempDir);
	}

	// Copy files to temp directory with sequential names
	imageFiles.forEach((file, index) => {
		const sourceFile = path.join(imageDirectory, file);
		const tempFile = path.join(
			tempDir,
			`frame_${String(index + 1).padStart(6, '0')}.png`
		);
		fs.copyFileSync(sourceFile, tempFile);
	});

	console.log(
		`Created ${imageFiles.length} sequential frames in temp directory`
	);

	// Use image2 demuxer with sequential pattern
	const pattern = path.join(tempDir, 'frame_%06d.png').replace(/\\/g, '/');
	const ffmpegCommand = `ffmpeg -y -framerate ${fps} -i "${pattern}" -c:v libx264 -pix_fmt yuv420p "${outputFile}"`;

	const startTime = new Date();
	console.log(`${startTime.toISOString()} : Running:`, ffmpegCommand);

	exec(ffmpegCommand, (error, stdout, stderr) => {
		// Clean up temp directory
		if (fs.existsSync(tempDir)) {
			fs.readdirSync(tempDir).forEach((file) => {
				fs.unlinkSync(path.join(tempDir, file));
			});
			fs.rmdirSync(tempDir);
		}

		if (error) {
			console.error('Error:', error.message);
			console.error('stderr:', stderr);
		} else {
			console.log('Video created successfully!');
			if (fs.existsSync(outputFile)) {
				const stats = fs.statSync(outputFile);
				console.log(
					`Output: ${outputFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`
				);
				console.log(
					`Elapsed time: ${((new Date() - startTime) / 1000).toFixed(
						2
					)} seconds`
				);
			}
		}
	});
}

// Node.js-based video creation using sharp and creating individual frames
async function createVideoWithNodeJS(
	imageDirectory,
	imageFiles,
	fps,
	outputFile
) {
	console.log('Attempting to create video using Node.js approach...');

	try {
		console.log('Creating an image sequence batch file for FFmpeg...');

		// Create a batch file that can be run when FFmpeg is available
		const batchContent = createFFmpegBatchFile(imageDirectory, fps, outputFile);
		const batchFile = outputFile.replace('.mp4', '_create_video.bat');

		fs.writeFileSync(batchFile, batchContent);

		console.log(`\nCreated batch file: ${batchFile}`);
		console.log(
			'This batch file contains the FFmpeg commands to create your video.'
		);
		console.log('\nTo use it:');
		console.log('1. Install FFmpeg (see instructions above)');
		console.log(`2. Run: ${batchFile}`);

		// Also create a PowerShell script
		const psContent = createFFmpegPowerShellScript(
			imageDirectory,
			fps,
			outputFile
		);
		const psFile = outputFile.replace('.mp4', '_create_video.ps1');

		fs.writeFileSync(psFile, psContent);
		console.log(`3. Or run PowerShell script: ${psFile}`);

		// Create file list for manual use
		createFileListForManualUse(imageDirectory, imageFiles, outputFile);
	} catch (error) {
		console.error('Node.js approach failed:', error.message);
		console.log('Creating manual scripts for when FFmpeg is available...');

		const batchContent = createFFmpegBatchFile(imageDirectory, fps, outputFile);
		const batchFile = outputFile.replace('.mp4', '_create_video.bat');

		fs.writeFileSync(batchFile, batchContent);
		console.log(`Created batch file: ${batchFile}`);
	}
}

function createFFmpegBatchFile(imageDirectory, fps, outputFile) {
	return `@echo off
echo Creating video from images in ${imageDirectory}
echo Frame rate: ${fps} FPS
echo Output: ${outputFile}
echo.

REM Try glob pattern first
ffmpeg -y -framerate ${fps} -pattern_type glob -i "${imageDirectory}\\*.png" -c:v libx264 -pix_fmt yuv420p "${outputFile}"

REM If that fails, try with file list
if %errorlevel% neq 0 (
    echo Glob pattern failed, trying file list approach...
    ffmpeg -y -f concat -safe 0 -r ${fps} -i "${imageDirectory}\\file_list.txt" -c:v libx264 -pix_fmt yuv420p "${outputFile}"
)

if %errorlevel% equ 0 (
    echo Video created successfully!
    dir "${outputFile}"
) else (
    echo Failed to create video. Make sure FFmpeg is installed and in PATH.
    echo Download from: https://ffmpeg.org/download.html
)

pause`;
}

function createFFmpegPowerShellScript(imageDirectory, fps, outputFile) {
	return `# PowerShell script to create video from images
Write-Host "Creating video from images in ${imageDirectory}"
Write-Host "Frame rate: ${fps} FPS"
Write-Host "Output: ${outputFile}"
Write-Host ""

# Try glob pattern first
$result = & ffmpeg -y -framerate ${fps} -pattern_type glob -i "${imageDirectory}\\*.png" -c:v libx264 -pix_fmt yuv420p "${outputFile}" 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Host "Glob pattern failed, trying file list approach..."
    & ffmpeg -y -f concat -safe 0 -r ${fps} -i "${imageDirectory}\\file_list.txt" -c:v libx264 -pix_fmt yuv420p "${outputFile}"
}

if ($LASTEXITCODE -eq 0) {
    Write-Host "Video created successfully!"
    Get-Item "${outputFile}" | Select-Object Name, Length, LastWriteTime
} else {
    Write-Host "Failed to create video. Make sure FFmpeg is installed and in PATH."
    Write-Host "Download from: https://ffmpeg.org/download.html"
}

Read-Host "Press Enter to continue..."`;
}

function createFileListForManualUse(imageDirectory, imageFiles, outputFile) {
	const fileListPath = path.join(imageDirectory, 'file_list.txt');

	const fileListContent = imageFiles.map((file) => `file '${file}'`).join('\n');

	fs.writeFileSync(fileListPath, fileListContent);
	console.log(`Created file list: ${fileListPath}`);
}

function createVideoWithFileList(imageDirectory, imageFiles, fps, outputFile) {
	// For image sequences, we need to use a different approach
	// Check if images have a consistent naming pattern
	const firstFile = imageFiles[0];
	const lastFile = imageFiles[imageFiles.length - 1];

	console.log(
		`Processing ${imageFiles.length} images from ${firstFile} to ${lastFile}`
	);

	// Try to detect if files have a sequential numeric pattern
	const hasSequentialPattern =
		/\d+/.test(firstFile) && imageFiles.every((file) => /\d+/.test(file));

	if (hasSequentialPattern) {
		// Use pattern-based approach for sequential images
		console.log(
			'Detected sequential numbering pattern, using image2 demuxer...'
		);
		createVideoWithPattern(imageDirectory, imageFiles, fps, outputFile);
	} else {
		// Use concat demuxer with individual image durations
		console.log('Using concat demuxer with individual image frames...');
		createVideoWithConcatImages(imageDirectory, imageFiles, fps, outputFile);
	}
}

function createVideoWithPattern(imageDirectory, imageFiles, fps, outputFile) {
	// Try to create a pattern from the first file
	const firstFile = imageFiles[0];
	const pattern = firstFile.replace(/\d+/, '%04d'); // Assume 4-digit padding

	const absoluteImageDirectory = path.resolve(imageDirectory);
	const inputPattern = path
		.join(absoluteImageDirectory, pattern)
		.replace(/\\/g, '/');

	console.log(`Using pattern: ${inputPattern}`);

	// Use image2 demuxer for sequential images
	const ffmpegCommand = `ffmpeg -y -framerate ${fps} -i "${inputPattern}" -c:v libx264 -pix_fmt yuv420p "${outputFile}"`;

	console.log('Running FFmpeg command:');
	console.log(ffmpegCommand);

	exec(ffmpegCommand, (error, stdout, stderr) => {
		if (error) {
			console.error('Pattern approach failed:', error.message);
			console.log('Falling back to concat approach...');
			createVideoWithConcatImages(imageDirectory, imageFiles, fps, outputFile);
			return;
		}

		console.log('Video created successfully using pattern approach!');
		console.log('FFmpeg output:', stdout);

		// Check if output file exists and show its size
		if (fs.existsSync(outputFile)) {
			const stats = fs.statSync(outputFile);
			console.log(`Output file: ${outputFile}`);
			console.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
		}
	});
}

function createVideoWithConcatImages(
	imageDirectory,
	imageFiles,
	fps,
	outputFile
) {
	// Create a temporary file list for FFmpeg with durations
	const fileListPath = path.join(imageDirectory, 'temp_file_list.txt');
	const frameDuration = 1 / fps; // Duration per frame in seconds

	// Use absolute paths and specify duration for each image
	const absoluteImageDirectory = path.resolve(imageDirectory);
	const fileListContent =
		imageFiles
			.map((file) => {
				const filePath = path
					.resolve(absoluteImageDirectory, file)
					.replace(/\\/g, '/');
				return `file '${filePath}'\nduration ${frameDuration}`;
			})
			.join('\n') +
		`\nfile '${path
			.resolve(absoluteImageDirectory, imageFiles[imageFiles.length - 1])
			.replace(/\\/g, '/')}'`; // Last frame needs to be repeated

	fs.writeFileSync(fileListPath, fileListContent);

	console.log(
		`Created temp file list with ${imageFiles.length} entries and durations`
	);
	console.log('Sample entries:');
	console.log(fileListContent.split('\n').slice(0, 4).join('\n'));

	// FFmpeg command using concat demuxer with durations
	const ffmpegCommand = `ffmpeg -y -f concat -safe 0 -i "${fileListPath}" -c:v libx264 -pix_fmt yuv420p "${outputFile}"`;

	console.log('Running FFmpeg command:');
	console.log(ffmpegCommand);

	exec(ffmpegCommand, (error, stdout, stderr) => {
		// Clean up temporary file
		if (fs.existsSync(fileListPath)) {
			fs.unlinkSync(fileListPath);
		}

		if (error) {
			console.error('Error creating video with concat images:', error.message);
			console.error('FFmpeg stderr:', stderr);

			// Create helper files instead of failing
			console.log('\nCreating helper scripts for manual video creation...');
			createVideoWithNodeJS(
				imageDirectory,
				getImageFiles(imageDirectory),
				fps,
				outputFile
			);
			return;
		}

		console.log('Video created successfully using concat images approach!');
		console.log('FFmpeg output:', stdout);

		// Check if output file exists and show its size
		if (fs.existsSync(outputFile)) {
			const stats = fs.statSync(outputFile);
			console.log(`Output file: ${outputFile}`);
			console.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
		}
	});
}

function showUsage() {
	console.log(
		'Usage: node makeVideo.cjs <image_directory> <fps> [output_file]'
	);
	console.log('');
	console.log('Arguments:');
	console.log('  image_directory  Directory containing image files');
	console.log('  fps             Frames per second for the output video');
	console.log(
		'  output_file     Output video file name (optional, defaults to output.mp4)'
	);
	console.log('');
	console.log('Examples:');
	console.log('  node makeVideo.cjs ./images 30');
	console.log('  node makeVideo.cjs C:\\path\\to\\images 24 my_video.mp4');
	console.log('');
	console.log('Supported image formats: JPG, JPEG, PNG, BMP, TIFF, GIF');
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
	console.error('Error: Missing required arguments.');
	showUsage();
	process.exit(1);
}

const imageDirectory = args[0];
const fps = parseFloat(args[1]);
const outputFile = args[2] || 'output.mp4';

// Validate arguments
if (!fs.existsSync(imageDirectory)) {
	console.error(`Error: Directory "${imageDirectory}" does not exist.`);
	process.exit(1);
}

if (!fs.statSync(imageDirectory).isDirectory()) {
	console.error(`Error: "${imageDirectory}" is not a directory.`);
	process.exit(1);
}

if (isNaN(fps) || fps <= 0) {
	console.error('Error: FPS must be a positive number.');
	process.exit(1);
}

console.log(`Creating video from images in: ${imageDirectory}`);
console.log(`Frame rate: ${fps} FPS`);
console.log(`Output file: ${outputFile}`);
console.log('');

// Create the video
(async () => {
	try {
		await createVideo(imageDirectory, fps, outputFile);
	} catch (error) {
		console.error('Error:', error.message);
		process.exit(1);
	}
})();

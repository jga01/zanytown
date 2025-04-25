// Internal cache for loaded image assets
const imageCache = new Map();
let imagesToLoad = 0;
let imagesLoaded = 0;
let progressUpdater = null; // Function to call for progress updates

/**
 * Loads a single image and caches it.
 * @param {string} url - The URL of the image to load.
 * @returns {Promise<HTMLImageElement>} A promise that resolves with the loaded image or rejects on error.
 */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    // Return cached image immediately if available
    if (imageCache.has(url)) {
      resolve(imageCache.get(url));
      return;
    }

    // Create new image element
    const img = new Image();

    img.onload = () => {
      // console.log(`Asset loaded: ${url}`); // Debugging log
      imageCache.set(url, img); // Store in cache
      imagesLoaded++;
      if (progressUpdater) {
        progressUpdater(imagesLoaded, imagesToLoad); // Report progress
      }
      resolve(img); // Resolve the promise with the image
    };

    img.onerror = (err) => {
      console.error(`Failed to load image: ${url}`, err);
      imagesLoaded++; // Count as 'loaded' anyway to prevent loading stall
      if (progressUpdater) {
        progressUpdater(imagesLoaded, imagesToLoad); // Report progress even on error
      }
      // Resolve with null? Or reject? Rejecting might stop Promise.all. Let's resolve with null.
      // reject(new Error(`Failed to load image: ${url}`));
      resolve(null); // Resolve with null to allow Promise.allSettled/Promise.all to continue
    };

    img.src = url; // Start loading
  });
}

/**
 * Preloads a list of asset URLs.
 * @param {Set<string>} urlsToLoad - A Set of unique image URLs to load.
 * @param {Function} [updater=(loaded, total) => {}] - Optional callback function to report progress. Signature: (loadedCount, totalCount).
 * @returns {Promise<void>} A promise that resolves when all assets are attempted (loaded or failed).
 */
export async function preloadAssets(
  urlsToLoad,
  updater = (loaded, total) => {}
) {
  if (!urlsToLoad || urlsToLoad.size === 0) {
    console.log("No assets specified for preloading.");
    return Promise.resolve(); // Nothing to load
  }

  progressUpdater = updater; // Store the updater function
  imagesToLoad = urlsToLoad.size;
  imagesLoaded = 0;
  console.log(`Preloading ${imagesToLoad} image asset(s)...`);

  // Initial progress report
  if (progressUpdater) {
    progressUpdater(imagesLoaded, imagesToLoad);
  }

  const loadPromises = [];
  urlsToLoad.forEach((url) => {
    loadPromises.push(loadImage(url));
  });

  // Use Promise.allSettled to wait for all loads, even if some fail
  const results = await Promise.allSettled(loadPromises);

  let successCount = 0;
  let failCount = 0;
  results.forEach((result) => {
    if (result.status === "fulfilled" && result.value !== null) {
      successCount++;
    } else {
      failCount++;
    }
  });

  console.log(
    `Asset preloading complete. Success: ${successCount}, Failed: ${failCount}`
  );
  progressUpdater = null; // Clear updater reference
  // The promise returned by this async function resolves here.
}

/**
 * Retrieves a loaded asset from the cache.
 * @param {string} url - The URL of the asset to retrieve.
 * @returns {HTMLImageElement | undefined} The cached Image element, or undefined if not loaded/cached.
 */
export function getAsset(url) {
  return imageCache.get(url);
}

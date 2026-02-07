

import { useState, useRef } from 'react';
import { ImageState, AIConfig, MaskRegion, Bubble } from '../types';
import { detectAndTypesetComic, fetchRawDetectedRegions } from '../services/geminiService';
import { generateMaskedImage, detectBubbleColor } from '../services/exportService';

interface UseProcessorProps {
    images: ImageState[];
    setImages: (newImagesOrUpdater: ImageState[] | ((prev: ImageState[]) => ImageState[]), skipHistory?: boolean) => void;
    aiConfig: AIConfig;
}

export const useProcessor = ({ images, setImages, aiConfig }: UseProcessorProps) => {
    const [isProcessingBatch, setIsProcessingBatch] = useState(false);
    const abortControllerRef = useRef<AbortController | null>(null);

    // --- Core Logic: Process a Single Image ---
    const runDetectionForImage = async (img: ImageState, signal?: AbortSignal) => {
        // 1. Mark as processing
        setImages(prev => prev.map(p => p.id === img.id ? { ...p, status: 'processing', errorMessage: undefined } : p));
        
        try {
            let sourceBase64 = img.base64;
            const useMaskedImage = aiConfig.enableMaskedImageMode && img.maskRegions && img.maskRegions.length > 0;
            
            // 2. Generate masked image if needed
            if (useMaskedImage) {
                sourceBase64 = await generateMaskedImage(img);
            }

            // 3. Call AI Service
            const detected = await detectAndTypesetComic(sourceBase64, aiConfig, signal, img.maskRegions);
            let finalDetected = detected;

            // 4. Snap Logic (Dialog Snapping)
            if (aiConfig.enableDialogSnap) {
                finalDetected = detected.map(b => {
                    if (!img.maskRegions || img.maskRegions.length === 0) return b;
                    let nearestMask: MaskRegion | null = null; 
                    let minDistance = Infinity;
                    
                    img.maskRegions.forEach(mask => {
                        const dist = Math.sqrt(Math.pow(b.x - mask.x, 2) + Math.pow(b.y - mask.y, 2));
                        if (dist < minDistance) { minDistance = dist; nearestMask = mask; }
                    });

                    if (nearestMask && minDistance < 15) { // 15% threshold
                        const updates: any = { x: (nearestMask as MaskRegion).x, y: (nearestMask as MaskRegion).y };
                        if (aiConfig.forceSnapSize) { 
                            updates.width = (nearestMask as MaskRegion).width; 
                            updates.height = (nearestMask as MaskRegion).height; 
                        }
                        return { ...b, ...updates };
                    }
                    return b;
                });
            }

            // 5. Convert to Bubbles & Detect Background Colors
            const processedBubbles = await Promise.all(finalDetected.map(async (d) => {
                let color = '#ffffff';
                // Only detect color if enabled globally and logic permits
                if (aiConfig.autoDetectBackground !== false) {
                    color = await detectBubbleColor(
                        img.url || `data:image/png;base64,${img.base64}`, 
                        d.x, d.y, d.width, d.height
                    );
                }
                return {
                    id: crypto.randomUUID(),
                    x: d.x, y: d.y, width: d.width, height: d.height,
                    text: d.text, isVertical: d.isVertical,
                    fontFamily: (d.fontFamily as any) || 'noto', // Use AI-detected font or default
                    fontSize: aiConfig.defaultFontSize,
                    color: '#0f172a',
                    backgroundColor: color,
                    rotation: d.rotation || 0,
                    maskShape: aiConfig.defaultMaskShape,
                    maskCornerRadius: aiConfig.defaultMaskCornerRadius,
                    maskFeather: aiConfig.defaultMaskFeather
                } as Bubble;
            }));

            // 6. Update State with Result
            setImages(prev => prev.map(p => p.id === img.id ? { 
                ...p, 
                bubbles: useMaskedImage ? [...p.bubbles, ...processedBubbles] : processedBubbles, // Append or Replace
                status: 'done' 
            } : p));

        } catch (e: any) {
            if (e.message && e.message.includes('Aborted')) { 
                setImages(prev => prev.map(p => p.id === img.id ? { ...p, status: 'idle', errorMessage: undefined } : p)); 
                return; 
            }
            console.error("AI Error for " + img.name, e);
            setImages(prev => prev.map(p => p.id === img.id ? { ...p, status: 'error', errorMessage: e.message || 'Unknown error occurred' } : p));
        }
    };

    // --- Batch Managers ---

    const stopProcessing = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            setIsProcessingBatch(false);
        }
    };

    const processQueue = async (queue: ImageState[], concurrency: number) => {
        if (queue.length === 0) return;
        
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const signal = controller.signal;
        setIsProcessingBatch(true);

        try {
            const batchSize = Math.max(1, concurrency);
            for (let i = 0; i < queue.length; i += batchSize) {
                if (signal.aborted) break;
                const chunk = queue.slice(i, i + batchSize);
                await Promise.all(chunk.map(img => runDetectionForImage(img, signal)));
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsProcessingBatch(false);
            abortControllerRef.current = null;
        }
    };

    // --- Public Actions ---

    const handleBatchProcess = async (currentImage: ImageState | undefined, onlyCurrent: boolean, concurrency: number) => {
        if (isProcessingBatch) return;

        if (onlyCurrent && currentImage) {
            // Single Mode
            const controller = new AbortController();
            abortControllerRef.current = controller;
            setIsProcessingBatch(true);
            try {
                await runDetectionForImage(currentImage, controller.signal);
            } finally {
                setIsProcessingBatch(false);
                abortControllerRef.current = null;
            }
        } else {
            // Batch Mode (Pending Only)
            const queue = images.filter(img => !img.skipped && (img.status === 'idle' || img.status === 'error'));
            if (queue.length === 0) {
                alert("All images are already processed or skipped.");
                return;
            }
            await processQueue(queue, concurrency);
        }
    };

    const handleResetStatus = () => {
        if (isProcessingBatch) return;
        const targets = images.filter(img => !img.skipped);
        if (targets.length === 0) return;

        const msg = aiConfig.language === 'zh' 
            ? `重置所有 ${targets.length} 张图片的状态？\n重置后可以重新使用“批量处理”功能。` 
            : `Reset status for all ${targets.length} images?\nThis will allow them to be re-processed using "Batch".`;

        if (confirm(msg)) {
             setImages(prev => prev.map(img => !img.skipped ? { ...img, status: 'idle', errorMessage: undefined } : img));
        }
    };

    const handleLocalDetectionScan = async (currentImage: ImageState | undefined, batch: boolean, concurrency: number) => {
        if (!aiConfig.useTextDetectionApi || !aiConfig.textDetectionApiUrl) {
            alert("Please enable 'Local Text Detection' in Settings first.");
            return;
        }
        
        const targets = batch 
            ? images.filter(img => !img.skipped && img.detectionStatus !== 'done') 
            : (currentImage ? [currentImage] : []);

        if (targets.length === 0) {
            if (batch) alert("All images already scanned.");
            return;
        }

        const controller = new AbortController();
        abortControllerRef.current = controller;
        setIsProcessingBatch(true);

        try {
            const batchSize = Math.max(1, concurrency);
            for (let i = 0; i < targets.length; i += batchSize) {
                if (controller.signal.aborted) break;
                const chunk = targets.slice(i, i + batchSize);
                
                await Promise.all(chunk.map(async (img) => {
                    setImages(prev => prev.map(p => p.id === img.id ? { ...p, detectionStatus: 'processing' } : p));
                    try {
                        const regions = await fetchRawDetectedRegions(img.base64, aiConfig.textDetectionApiUrl!);
                        const maskRegions: MaskRegion[] = regions.map(r => ({
                            id: crypto.randomUUID(),
                            x: r.x, y: r.y, width: r.width, height: r.height
                        }));
                        setImages(prev => prev.map(p => p.id === img.id ? { 
                            ...p, 
                            maskRegions: [...(p.maskRegions || []), ...maskRegions], 
                            detectionStatus: 'done' 
                        } : p));
                    } catch (e) {
                        console.error(e);
                        setImages(prev => prev.map(p => p.id === img.id ? { ...p, detectionStatus: 'error' } : p));
                    }
                }));
            }
        } finally {
            setIsProcessingBatch(false);
            abortControllerRef.current = null;
        }
    };

    const handleGlobalColorDetection = async (concurrency: number = 1) => {
        if (isProcessingBatch) return;
        
        const targets = images.filter(img => !img.skipped && img.bubbles.length > 0);
        if (targets.length === 0) return;

        const controller = new AbortController();
        abortControllerRef.current = controller;
        setIsProcessingBatch(true);

        try {
            const batchSize = Math.max(1, concurrency);
            for (let i = 0; i < targets.length; i += batchSize) {
                if (controller.signal.aborted) break;
                const chunk = targets.slice(i, i + batchSize);
                
                await Promise.all(chunk.map(async (img) => {
                    setImages(prev => prev.map(p => p.id === img.id ? { ...p, status: 'processing' } : p));
                    try {
                        const updatedBubbles = await Promise.all(img.bubbles.map(async (b) => {
                            const color = await detectBubbleColor(
                                img.url || `data:image/png;base64,${img.base64}`, 
                                b.x, b.y, b.width, b.height
                            );
                            return { ...b, backgroundColor: color };
                        }));
                        setImages(prev => prev.map(p => p.id === img.id ? { ...p, bubbles: updatedBubbles, status: 'done' } : p));
                    } catch (e) {
                         console.error("Global detection error", e);
                         setImages(prev => prev.map(p => p.id === img.id ? { ...p, status: 'done' } : p));
                    }
                }));
            }
        } finally {
            setIsProcessingBatch(false);
            abortControllerRef.current = null;
        }
    };

    return {
        isProcessingBatch,
        handleBatchProcess,
        handleResetStatus,
        handleLocalDetectionScan,
        stopProcessing,
        handleGlobalColorDetection
    };
};


import React from 'react';
import { BubbleLayer } from './BubbleLayer';
import { RegionLayer } from './RegionLayer';
import { HandleType } from '../types';
import { Maximize } from 'lucide-react';
import { t } from '../services/i18n';
import { useProjectContext } from '../contexts/ProjectContext';

interface WorkspaceProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onCanvasMouseDown: (e: React.MouseEvent) => void;
  onMaskMouseDown: (e: React.MouseEvent, id: string) => void;
  onBubbleMouseDown: (e: React.MouseEvent, id: string) => void;
  onResizeStart: (e: React.MouseEvent, id: string, type: 'bubble' | 'mask', handle: HandleType) => void;
}

export const Workspace: React.FC<WorkspaceProps> = ({
  containerRef, onCanvasMouseDown, onMaskMouseDown, onBubbleMouseDown, onResizeStart
}) => {
  const { 
    currentImage, drawTool, selectedMaskId, selectedBubbleId, aiConfig, 
    setImages, currentId, setSelectedMaskId, setSelectedBubbleId,
    updateBubble, triggerAutoColorDetection
  } = useProjectContext();
  
  const lang = aiConfig.language;
  const bubbles = currentImage?.bubbles || [];
  const maskRegions = currentImage?.maskRegions || [];

  if (!currentImage) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center opacity-30 select-none">
        <Maximize size={64} className="mx-auto mb-4" />
        <h2 className="text-2xl font-bold">{t('noImageSelected', lang)}</h2>
        <p className="mt-2 text-sm">{t('dragDrop', lang)}</p>
      </div>
    );
  }

  // Wrappers to handle deletion from within workspace
  const onDeleteMask = (id: string) => {
    if (!currentId) return;
    setImages(prev => prev.map(img => img.id === currentId ? { ...img, maskRegions: (img.maskRegions || []).filter(m => m.id !== id) } : img));
    setSelectedMaskId(null);
  };

  const onDeleteBubble = (id: string) => {
    if (!currentId) return;
    setImages(prev => prev.map(img => img.id === currentId ? { ...img, bubbles: img.bubbles.filter(b => b.id !== id) } : img));
    setSelectedBubbleId(null);
  };

  return (
    <div className="flex-1 overflow-auto flex items-center justify-center p-8 relative">
      <div className="relative shadow-2xl inline-block" ref={containerRef} style={{ maxWidth: '100%' }}>
        <img
          src={currentImage.url}
          alt="Workspace"
          className="max-h-[90vh] max-w-full block select-none pointer-events-none"
        />
        <div className="absolute inset-0" style={{ containerType: 'inline-size' } as React.CSSProperties}>
          <div
            className={`absolute inset-0 z-0 ${drawTool !== 'none' ? 'cursor-crosshair' : 'cursor-default'}`}
            onMouseDown={onCanvasMouseDown}
          />

          {drawTool === 'mask' && maskRegions.map(region => (
            <RegionLayer
              key={region.id}
              region={region}
              isSelected={selectedMaskId === region.id}
              onMouseDown={(e) => onMaskMouseDown(e, region.id)}
              onResizeStart={(e, handle) => onResizeStart(e, region.id, 'mask', handle)}
              onDelete={() => onDeleteMask(region.id)}
            />
          ))}

          {bubbles.map(bubble => (
            <BubbleLayer
              key={bubble.id}
              bubble={bubble}
              config={aiConfig}
              isSelected={selectedBubbleId === bubble.id}
              onMouseDown={(e) => onBubbleMouseDown(e, bubble.id)}
              onResizeStart={(e, handle) => onResizeStart(e, bubble.id, 'bubble', handle)}
              onUpdate={updateBubble}
              onDelete={() => onDeleteBubble(bubble.id)}
              onTriggerAutoColor={triggerAutoColorDetection}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

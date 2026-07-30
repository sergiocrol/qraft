import random
from collections import OrderedDict
from ..utils.logging import get_logger

logger = get_logger(__name__)

class QRProcessor:
    def __init__(self):
        self.alternative_scales = [
            [1.45, 0.1],
            [1.0, 0.15],
            [1.35, 0.05],
            [1.15, 0.2],
        ]
    
    def plan_qr_generations(self, qr_urls, num_images_per_prompt, user_conditioning_scales):
        if num_images_per_prompt is None:
            num_images_per_prompt = len(qr_urls)
        
        num_images_per_prompt = min(num_images_per_prompt, 3)
        
        logger.info(f"Planning generation: {len(qr_urls)} URLs, {num_images_per_prompt} images requested")
        logger.info(f"QR URLs: {qr_urls}")
        
        unique_urls = list(OrderedDict.fromkeys(qr_urls))
        logger.info(f"Unique URLs: {unique_urls}")
        
        generations = []
        
        for i in range(num_images_per_prompt):
            if i < len(unique_urls):
                qr_url = unique_urls[i]
                conditioning_scales = user_conditioning_scales
                description = f"unique_url_{i+1}"
                use_alternative = False
                
                logger.info(f"Generation {i+1}: Using unique URL {qr_url} with user scales {conditioning_scales}")
                
            else:
                qr_url = unique_urls[0]
                conditioning_scales = random.choice(self.alternative_scales)
                description = f"extra_generation_{i+1}_alt_scales"
                use_alternative = True
                
                logger.info(f"Generation {i+1}: Using first URL {qr_url} with alternative scales {conditioning_scales}")
            
            generations.append((qr_url, conditioning_scales, description, use_alternative))
        
        if len(qr_urls) > len(unique_urls):
            url_usage_count = {}
            
            for i, (qr_url, conditioning_scales, description, use_alternative) in enumerate(generations):
                if i < len(qr_urls):
                    original_url = qr_urls[i]
                    url_usage_count[original_url] = url_usage_count.get(original_url, 0) + 1
                    
                    if url_usage_count[original_url] > 1:
                        alternative_conditioning_scales = random.choice(self.alternative_scales)
                        generations[i] = (
                            original_url, 
                            alternative_conditioning_scales, 
                            f"repeated_url_{i+1}_alt_scales", 
                            True
                        )
                        logger.info(f"Generation {i+1}: Detected repeated URL {original_url}, using alternative scales {alternative_conditioning_scales}")
        
        return generations

    def get_generation_plan_summary(self, generations):
        summary = {
            "total_generations": len(generations),
            "unique_urls": len(set(gen[0] for gen in generations)),
            "user_scale_count": len([gen for gen in generations if not gen[3]]),
            "alternative_scale_count": len([gen for gen in generations if gen[3]]),
            "details": []
        }
        
        for i, (qr_url, conditioning_scales, description, use_alternative) in enumerate(generations):
            summary["details"].append({
                "index": i + 1,
                "url": qr_url[:50] + "..." if len(qr_url) > 50 else qr_url,
                "scales": conditioning_scales,
                "description": description,
                "uses_alternative_scales": use_alternative
            })
        
        return summary

def test_qr_processor():
    processor = QRProcessor()
    user_scales = [1.25, 0.1]
    
    test_cases = [
        {
            "urls": ["url-a"],
            "num_images": 3,
            "description": "1 URL, 3 images - should use user scales for first, alternative for others"
        },
        {
            "urls": ["url-a", "url-a", "url-b"],
            "num_images": 3,
            "description": "Repeated URLs - first url-a uses user scales, second url-a uses alternative, url-b uses user scales"
        },
        {
            "urls": ["url-a", "url-b", "url-c"],
            "num_images": 3,
            "description": "All unique URLs - all should use user scales"
        },
        {
            "urls": ["url-a", "url-b"],
            "num_images": 3,
            "description": "2 URLs, 3 images - first two use user scales, third uses url-a with alternative scales"
        },
        {
            "urls": ["url-a", "url-a", "url-a"],
            "num_images": 3,
            "description": "All same URLs - first uses user scales, others use user scales (same URL repeated)"
        }
    ]
    
    for i, test_case in enumerate(test_cases, 1):
        print(f"\n--- Test Case {i}: {test_case['description']} ---")
        generations = processor.plan_qr_generations(
            test_case["urls"], 
            test_case["num_images"], 
            user_scales
        )
        
        summary = processor.get_generation_plan_summary(generations)
        print(f"Summary: {summary}")
        
        for gen in generations:
            qr_url, scales, desc, alt = gen
            print(f"  {desc}: {qr_url} with scales {scales} (alternative: {alt})")

if __name__ == "__main__":
    test_qr_processor()
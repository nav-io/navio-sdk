// Quick test to see the raw format of blockchain.block.get_range_txs_keys
import WebSocket from 'ws';

const ws = new WebSocket('ws://testnet.nav.io:50005');
let requestId = 0;

function call(method, ...params) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const request = { jsonrpc: '2.0', id, method, params };

    const handler = (data) => {
      const response = JSON.parse(data.toString());
      if (response.id === id) {
        ws.removeListener('message', handler);
        if (response.error) {
          reject(new Error(JSON.stringify(response.error)));
        } else {
          resolve(response.result);
        }
      }
    };

    ws.on('message', handler);
    ws.send(JSON.stringify(request));

    setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error('Timeout'));
    }, 30000);
  });
}

ws.on('open', async () => {
  try {
    const version = await call('server.version', 'test', '1.4');
    console.log('Server version:', version);

    const tip = await call('blockchain.headers.subscribe');
    console.log('Chain tip height:', tip.height);

    // Try getting individual block's tx keys for a recent block
    // Start with the tip and work backwards to find a block with transactions
    for (let h = tip.height; h > Math.max(0, tip.height - 100); h--) {
      try {
        const result = await call('blockchain.block.get_txs_keys', h);
        if (result && ((Array.isArray(result) && result.length > 0) || (typeof result === 'object' && !Array.isArray(result)))) {
          console.log(`\n=== Block at height ${h} ===`);
          console.log('Result type:', typeof result);
          console.log('Is array:', Array.isArray(result));
          if (Array.isArray(result)) {
            console.log('Num elements:', result.length);
            for (let i = 0; i < Math.min(result.length, 3); i++) {
              console.log(`\n--- Element ${i} ---`);
              console.log('Type:', typeof result[i]);
              console.log('Is array:', Array.isArray(result[i]));
              const json = JSON.stringify(result[i], null, 2);
              console.log('Data:', json.substring(0, 2000));
              if (json.length > 2000) console.log('... (truncated)');
            }
          } else {
            const json = JSON.stringify(result, null, 2);
            console.log('Data:', json.substring(0, 3000));
          }
          break;
        }
      } catch (e) {
        // Skip errors for individual blocks
      }
    }

    // Also try the range method from a recent height
    console.log('\n\n=== Trying get_range_txs_keys ===');
    try {
      const rangeStart = Math.max(0, tip.height - 50);
      const rangeResult = await call('blockchain.block.get_range_txs_keys', rangeStart);
      console.log('Range result keys:', Object.keys(rangeResult));
      console.log('next_height:', rangeResult.next_height);
      console.log('blocks count:', rangeResult.blocks?.length);

      // Find first block with tx data
      if (rangeResult.blocks) {
        for (let i = 0; i < rangeResult.blocks.length; i++) {
          const block = rangeResult.blocks[i];
          const hasTx = (Array.isArray(block) && block.length > 0);
          if (hasTx) {
            console.log(`\nBlock at index ${i} (height ${rangeStart + i}):`);
            console.log('Block type:', typeof block);
            console.log('Is array:', Array.isArray(block));
            if (Array.isArray(block)) {
              console.log('Num transactions:', block.length);
              for (let j = 0; j < Math.min(block.length, 2); j++) {
                console.log(`\n  -- Transaction ${j} --`);
                console.log('  Type:', typeof block[j]);
                console.log('  Is array:', Array.isArray(block[j]));
                const json = JSON.stringify(block[j], null, 2);
                console.log('  Data:', json.substring(0, 2000));
              }
            }
            break;
          }
        }
      }
    } catch (e) {
      console.log('Range method error:', e.message);
    }

    ws.close();
  } catch (error) {
    console.error('Error:', error.message);
    ws.close();
  }
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error.message);
});

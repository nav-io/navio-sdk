#!/usr/bin/env tsx
/**
 * Database Analysis Script
 *
 * Analyzes the wallet database to see what's taking up space
 * Helps optimize database size by identifying large tables/data
 */

import * as path from 'path';
import * as fs from 'fs';
import { WalletDB } from '../src/wallet-db';

interface TableStats {
  name: string;
  rowCount: number;
  sizeBytes: number;
  avgRowSize: number;
  sampleRows?: number;
}

/**
 * Get table statistics
 */
async function getTableStats(db: any, tableName: string): Promise<TableStats> {
  try {
    // Get row count
    const countResult = db.exec(`SELECT COUNT(*) as count FROM ${tableName}`);
    const rowCount =
      countResult.length > 0 && countResult[0].values.length > 0
        ? (countResult[0].values[0][0] as number)
        : 0;

    if (rowCount === 0) {
      return {
        name: tableName,
        rowCount: 0,
        sizeBytes: 0,
        avgRowSize: 0,
      };
    }

    // Get approximate size by sampling rows
    // For TEXT columns, we'll estimate based on actual data
    let totalSize = 0;
    const sampleSize = Math.min(100, rowCount);

    // Get column info
    const schemaResult = db.exec(`PRAGMA table_info(${tableName})`);
    const columns = schemaResult.length > 0 ? schemaResult[0].values : [];

    // Sample rows to estimate size
    const sampleResult = db.exec(`SELECT * FROM ${tableName} LIMIT ${sampleSize}`);
    if (sampleResult.length > 0 && sampleResult[0].values.length > 0) {
      const rows = sampleResult[0].values;
      for (const row of rows) {
        let rowSize = 0;
        for (let i = 0; i < row.length; i++) {
          const value = row[i];
          if (value !== null && value !== undefined) {
            if (typeof value === 'string') {
              // Estimate: UTF-8 encoding, roughly 1-4 bytes per char
              rowSize += Buffer.from(value, 'utf8').length;
            } else if (typeof value === 'number') {
              rowSize += 8; // 64-bit number
            } else {
              rowSize += JSON.stringify(value).length;
            }
          }
        }
        totalSize += rowSize;
      }

      // Extrapolate to full table size
      const avgRowSize = totalSize / rows.length;
      const estimatedTotalSize = avgRowSize * rowCount;

      return {
        name: tableName,
        rowCount,
        sizeBytes: estimatedTotalSize,
        avgRowSize,
        sampleRows: rows.length,
      };
    }

    return {
      name: tableName,
      rowCount,
      sizeBytes: 0,
      avgRowSize: 0,
    };
  } catch (error) {
    console.error(`Error analyzing table ${tableName}:`, error);
    return {
      name: tableName,
      rowCount: 0,
      sizeBytes: 0,
      avgRowSize: 0,
    };
  }
}

/**
 * Get detailed information about a specific table
 */
function getTableDetails(db: any, tableName: string): void {
  try {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Table: ${tableName}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // Get schema
    const schemaResult = db.exec(`PRAGMA table_info(${tableName})`);
    if (schemaResult.length > 0) {
      console.log('Schema:');
      const columns = schemaResult[0].values;
      for (const col of columns) {
        console.log(`  - ${col[1]} (${col[2]})`);
      }
      console.log('');
    }

    // Get row count
    const countResult = db.exec(`SELECT COUNT(*) FROM ${tableName}`);
    const rowCount =
      countResult.length > 0 && countResult[0].values.length > 0
        ? (countResult[0].values[0][0] as number)
        : 0;
    console.log(`Total Rows: ${rowCount.toLocaleString()}\n`);

    // Show sample data for large TEXT columns
    if (tableName === 'tx_keys' || tableName === 'wallet_outputs') {
      const sampleResult = db.exec(`SELECT * FROM ${tableName} LIMIT 3`);
      if (sampleResult.length > 0 && sampleResult[0].values.length > 0) {
        console.log('Sample rows (first 3):');
        const rows = sampleResult[0].values;
        for (let i = 0; i < Math.min(3, rows.length); i++) {
          const row = rows[i];
          console.log(`\n  Row ${i + 1}:`);
          // Get column names
          const schemaResult = db.exec(`PRAGMA table_info(${tableName})`);
          if (schemaResult.length > 0) {
            const columns = schemaResult[0].values;
            for (let j = 0; j < Math.min(columns.length, row.length); j++) {
              const colName = columns[j][1] as string;
              let value = row[j];

              // Truncate long values
              if (typeof value === 'string' && value.length > 100) {
                value = value.substring(0, 100) + '...';
              }

              // Show size for TEXT columns
              if (typeof value === 'string') {
                const size = Buffer.from(value, 'utf8').length;
                console.log(`    ${colName}: ${size} bytes (${value.length} chars)`);
              } else {
                console.log(`    ${colName}: ${value}`);
              }
            }
          }
        }
        console.log('');
      }
    }

    // For tx_keys, show average keys_data size
    if (tableName === 'tx_keys') {
      const sizeResult = db.exec(`
        SELECT 
          AVG(LENGTH(keys_data)) as avg_size,
          MIN(LENGTH(keys_data)) as min_size,
          MAX(LENGTH(keys_data)) as max_size,
          SUM(LENGTH(keys_data)) as total_size
        FROM tx_keys
      `);
      if (sizeResult.length > 0 && sizeResult[0].values.length > 0) {
        const stats = sizeResult[0].values[0];
        console.log('keys_data Statistics:');
        console.log(`  Average size: ${Math.round(stats[0] as number).toLocaleString()} bytes`);
        console.log(`  Min size: ${stats[1]} bytes`);
        console.log(`  Max size: ${stats[2]} bytes`);
        console.log(`  Total size: ${Math.round(stats[3] as number).toLocaleString()} bytes\n`);
      }
    }

    // For wallet_outputs, show average output_data size
    if (tableName === 'wallet_outputs') {
      const sizeResult = db.exec(`
        SELECT 
          AVG(LENGTH(output_data)) as avg_size,
          MIN(LENGTH(output_data)) as min_size,
          MAX(LENGTH(output_data)) as max_size,
          SUM(LENGTH(output_data)) as total_size,
          COUNT(*) as total_rows,
          SUM(CASE WHEN is_spent = 1 THEN 1 ELSE 0 END) as spent_count,
          SUM(CASE WHEN is_spent = 0 THEN 1 ELSE 0 END) as unspent_count
        FROM wallet_outputs
      `);
      if (sizeResult.length > 0 && sizeResult[0].values.length > 0) {
        const stats = sizeResult[0].values[0];
        console.log('output_data Statistics:');
        console.log(`  Average size: ${Math.round(stats[0] as number).toLocaleString()} bytes`);
        console.log(`  Min size: ${stats[1]} bytes`);
        console.log(`  Max size: ${stats[2]} bytes`);
        console.log(`  Total size: ${Math.round(stats[3] as number).toLocaleString()} bytes`);
        console.log(`  Total rows: ${stats[4]}`);
        console.log(`  Spent outputs: ${stats[5]}`);
        console.log(`  Unspent outputs: ${stats[6]}\n`);
      }
    }
  } catch (error) {
    console.error(`Error getting details for ${tableName}:`, error);
  }
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const dbPath = args[0] || path.join(__dirname, '../test-wallet-sync.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`Database file not found: ${dbPath}`);
    process.exit(1);
  }

  const fileStats = fs.statSync(dbPath);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Database Size Analysis');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`Database file: ${dbPath}`);
  console.log(
    `File size: ${formatBytes(fileStats.size)} (${fileStats.size.toLocaleString()} bytes)\n`
  );

  try {
    const walletDB = new WalletDB(dbPath);
    await walletDB.initDatabase();
    const db = walletDB.getDatabase();

    // Get all table names
    const tablesResult = db.exec(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);

    if (tablesResult.length === 0 || tablesResult[0].values.length === 0) {
      console.log('No tables found in database.');
      return;
    }

    const tableNames = tablesResult[0].values.map((row: any[]) => row[0] as string);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Table Statistics');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const allStats: TableStats[] = [];

    for (const tableName of tableNames) {
      const stats = await getTableStats(db, tableName);
      allStats.push(stats);
    }

    // Sort by size (descending)
    allStats.sort((a, b) => b.sizeBytes - a.sizeBytes);

    // Print summary table
    console.log('Summary (sorted by estimated size):\n');
    console.log(
      'Table Name'.padEnd(25) + 'Rows'.padEnd(15) + 'Est. Size'.padEnd(15) + 'Avg Row Size'
    );
    console.log('-'.repeat(70));

    let totalEstimatedSize = 0;
    for (const stats of allStats) {
      totalEstimatedSize += stats.sizeBytes;
      const rowCountStr = stats.rowCount.toLocaleString().padEnd(15);
      const sizeStr = formatBytes(stats.sizeBytes).padEnd(15);
      const avgSizeStr = formatBytes(stats.avgRowSize);
      console.log(stats.name.padEnd(25) + rowCountStr + sizeStr + avgSizeStr);
    }

    console.log('-'.repeat(70));
    console.log(`Total estimated: ${formatBytes(totalEstimatedSize)}`);
    console.log(`File size: ${formatBytes(fileStats.size)}`);
    console.log(
      `Difference: ${formatBytes(fileStats.size - totalEstimatedSize)} (overhead/indexes)\n`
    );

    // Show detailed info for largest tables
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Detailed Analysis (Top 5 Largest Tables)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    for (let i = 0; i < Math.min(5, allStats.length); i++) {
      if (allStats[i].rowCount > 0) {
        getTableDetails(db, allStats[i].name);
      }
    }

    // Recommendations
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Optimization Recommendations');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const txKeysStats = allStats.find(s => s.name === 'tx_keys');
    const walletOutputsStats = allStats.find(s => s.name === 'wallet_outputs');

    if (txKeysStats && txKeysStats.rowCount > 0) {
      console.log('⚠️  tx_keys table:');
      console.log(`   - Contains ${txKeysStats.rowCount.toLocaleString()} transaction keys`);
      console.log(`   - Estimated size: ${formatBytes(txKeysStats.sizeBytes)}`);
      console.log(`   - Recommendation: Consider using keepTxKeys: false in sync options`);
      console.log(`     to avoid storing transaction keys after processing.\n`);
    }

    if (walletOutputsStats && walletOutputsStats.rowCount > 0) {
      console.log('💾 wallet_outputs table:');
      console.log(`   - Contains ${walletOutputsStats.rowCount.toLocaleString()} wallet outputs`);
      console.log(`   - Estimated size: ${formatBytes(walletOutputsStats.sizeBytes)}`);
      console.log(`   - This is expected - these are your wallet's UTXOs.\n`);
    }

    // Check for old/spent outputs that could be archived
    if (walletOutputsStats && walletOutputsStats.rowCount > 0) {
      const spentResult = db.exec(`
        SELECT COUNT(*) as count 
        FROM wallet_outputs 
        WHERE is_spent = 1
      `);
      const spentCount =
        spentResult.length > 0 && spentResult[0].values.length > 0
          ? (spentResult[0].values[0][0] as number)
          : 0;

      if (spentCount > 0) {
        console.log('🗑️  Spent outputs:');
        console.log(`   - ${spentCount.toLocaleString()} spent outputs found`);
        console.log(`   - Consider archiving or deleting old spent outputs to reduce size.\n`);
      }
    }

    await walletDB.close();
  } catch (error) {
    console.error('Error analyzing database:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});



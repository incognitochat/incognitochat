package dynamotest

import (
	"context"
	"errors"
	"maps"
	"slices"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Units are read and write capacity units.
type Units struct {
	Read, Write float64
}

// Meter wraps a DynamoDB client and adds up the capacity every call
// consumes, per table, so tests can check what a route costs. It asks each
// call for its consumed capacity. A write refused by its condition is
// charged too, but DynamoDB doesn't report it: Meter counts it as one write
// unit, which is what it costs for the small items such writes touch here.
// So is a transaction cancelled (by a condition, say): AWS bills it as if
// it had gone through, two write units for each item it names (prepare and
// commit) that is under 1 KB, and Meter counts that. For one that goes
// through, DynamoDB Local reports 2 or 3 units whatever its items: count
// what it wrote (Written) instead.
//
// It also records which calls were made, in order (Calls), and the keys of
// every item a write named (Written), so tests can check what a route does
// and what it names.
type Meter struct {
	Client *dynamodb.Client

	mu      sync.Mutex
	units   map[string]Units
	calls   []string
	written map[string][]string // table -> "<pk> <sk>" of every item a write named
}

// NewMeter returns a meter over client.
func NewMeter(client *dynamodb.Client) *Meter {
	return &Meter{Client: client, units: map[string]Units{}, written: map[string][]string{}}
}

// Units returns what table has consumed since the last Reset.
func (m *Meter) Units(table string) Units {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.units[table]
}

// Calls returns the calls made since the last Reset, in order, each as
// "<operation> <table>[,<table>…]".
func (m *Meter) Calls() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.Clone(m.calls)
}

// Written returns the keys, "<pk> <sk>", of every item a write to table
// named (put, updated, deleted or checked) since the meter was made: Reset
// doesn't forget them.
func (m *Meter) Written(table string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.Clone(m.written[table])
}

// Reset starts counting units and calls again from zero.
func (m *Meter) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.units = map[string]Units{}
	m.calls = nil
}

func (m *Meter) call(op string, tables ...string) {
	slices.Sort(tables)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, op+" "+strings.Join(slices.Compact(tables), ","))
}

func (m *Meter) wrote(table *string, key map[string]types.AttributeValue) {
	str := func(name string) string {
		if v, ok := key[name].(*types.AttributeValueMemberS); ok {
			return v.Value
		}
		return ""
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.written[aws.ToString(table)] = append(m.written[aws.ToString(table)], str("pk")+" "+str("sk"))
}

func (m *Meter) addRead(c *types.ConsumedCapacity) {
	if c == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	u := m.units[aws.ToString(c.TableName)]
	u.Read += aws.ToFloat64(c.CapacityUnits)
	m.units[aws.ToString(c.TableName)] = u
}

func (m *Meter) addWrite(c *types.ConsumedCapacity) {
	if c == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	u := m.units[aws.ToString(c.TableName)]
	u.Write += aws.ToFloat64(c.CapacityUnits)
	m.units[aws.ToString(c.TableName)] = u
}

// refused books a write refused by its condition.
func (m *Meter) refused(table *string, err error) {
	var failed *types.ConditionalCheckFailedException
	if !errors.As(err, &failed) {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	u := m.units[aws.ToString(table)]
	u.Write++
	m.units[aws.ToString(table)] = u
}

const total = types.ReturnConsumedCapacityTotal

// GetItem reads one item.
func (m *Meter) GetItem(ctx context.Context, in *dynamodb.GetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	m.call("GetItem", aws.ToString(in.TableName))
	in.ReturnConsumedCapacity = total
	out, err := m.Client.GetItem(ctx, in, opts...)
	if err == nil {
		m.addRead(out.ConsumedCapacity)
	}
	return out, err
}

// BatchGetItem reads several items.
func (m *Meter) BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	m.call("BatchGetItem", slices.Collect(maps.Keys(in.RequestItems))...)
	in.ReturnConsumedCapacity = total
	out, err := m.Client.BatchGetItem(ctx, in, opts...)
	if err == nil {
		for i := range out.ConsumedCapacity {
			m.addRead(&out.ConsumedCapacity[i])
		}
	}
	return out, err
}

// Query reads a partition, or part of one.
func (m *Meter) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	m.call("Query", aws.ToString(in.TableName))
	in.ReturnConsumedCapacity = total
	out, err := m.Client.Query(ctx, in, opts...)
	if err == nil {
		m.addRead(out.ConsumedCapacity)
	}
	return out, err
}

// PutItem writes one item.
func (m *Meter) PutItem(ctx context.Context, in *dynamodb.PutItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	m.call("PutItem", aws.ToString(in.TableName))
	m.wrote(in.TableName, in.Item)
	in.ReturnConsumedCapacity = total
	out, err := m.Client.PutItem(ctx, in, opts...)
	if err == nil {
		m.addWrite(out.ConsumedCapacity)
	}
	m.refused(in.TableName, err)
	return out, err
}

// UpdateItem changes one item.
func (m *Meter) UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	m.call("UpdateItem", aws.ToString(in.TableName))
	m.wrote(in.TableName, in.Key)
	in.ReturnConsumedCapacity = total
	out, err := m.Client.UpdateItem(ctx, in, opts...)
	if err == nil {
		m.addWrite(out.ConsumedCapacity)
	}
	m.refused(in.TableName, err)
	return out, err
}

// DeleteItem deletes one item.
func (m *Meter) DeleteItem(ctx context.Context, in *dynamodb.DeleteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	m.call("DeleteItem", aws.ToString(in.TableName))
	m.wrote(in.TableName, in.Key)
	in.ReturnConsumedCapacity = total
	out, err := m.Client.DeleteItem(ctx, in, opts...)
	if err == nil {
		m.addWrite(out.ConsumedCapacity)
	}
	m.refused(in.TableName, err)
	return out, err
}

// BatchWriteItem writes or deletes several items.
func (m *Meter) BatchWriteItem(ctx context.Context, in *dynamodb.BatchWriteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error) {
	m.call("BatchWriteItem", slices.Collect(maps.Keys(in.RequestItems))...)
	for table, requests := range in.RequestItems {
		for _, r := range requests {
			switch {
			case r.PutRequest != nil:
				m.wrote(&table, r.PutRequest.Item)
			case r.DeleteRequest != nil:
				m.wrote(&table, r.DeleteRequest.Key)
			}
		}
	}
	in.ReturnConsumedCapacity = total
	out, err := m.Client.BatchWriteItem(ctx, in, opts...)
	if err == nil {
		for i := range out.ConsumedCapacity {
			m.addWrite(&out.ConsumedCapacity[i])
		}
	}
	return out, err
}

// TransactWriteItems writes several items at once.
func (m *Meter) TransactWriteItems(ctx context.Context, in *dynamodb.TransactWriteItemsInput, opts ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	var tables []string
	for _, it := range in.TransactItems {
		switch {
		case it.Put != nil:
			tables = append(tables, aws.ToString(it.Put.TableName))
			m.wrote(it.Put.TableName, it.Put.Item)
		case it.Update != nil:
			tables = append(tables, aws.ToString(it.Update.TableName))
			m.wrote(it.Update.TableName, it.Update.Key)
		case it.Delete != nil:
			tables = append(tables, aws.ToString(it.Delete.TableName))
			m.wrote(it.Delete.TableName, it.Delete.Key)
		case it.ConditionCheck != nil:
			tables = append(tables, aws.ToString(it.ConditionCheck.TableName))
			m.wrote(it.ConditionCheck.TableName, it.ConditionCheck.Key)
		}
	}
	// Each item's table, kept apart: call sorts and compacts its own.
	named := slices.Clone(tables)
	m.call("TransactWriteItems", tables...)
	in.ReturnConsumedCapacity = total
	out, err := m.Client.TransactWriteItems(ctx, in, opts...)
	if err == nil {
		for i := range out.ConsumedCapacity {
			m.addWrite(&out.ConsumedCapacity[i])
		}
	}
	var cancelled *types.TransactionCanceledException
	if errors.As(err, &cancelled) {
		m.mu.Lock()
		for _, table := range named {
			u := m.units[table]
			u.Write += 2
			m.units[table] = u
		}
		m.mu.Unlock()
	}
	return out, err
}

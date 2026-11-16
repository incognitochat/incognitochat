package dynamotest

import (
	"context"
	"errors"
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
type Meter struct {
	Client *dynamodb.Client

	mu    sync.Mutex
	units map[string]Units
}

// NewMeter returns a meter over client.
func NewMeter(client *dynamodb.Client) *Meter {
	return &Meter{Client: client, units: map[string]Units{}}
}

// Units returns what table has consumed since the last Reset.
func (m *Meter) Units(table string) Units {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.units[table]
}

// Reset starts counting again from zero.
func (m *Meter) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.units = map[string]Units{}
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
	in.ReturnConsumedCapacity = total
	out, err := m.Client.GetItem(ctx, in, opts...)
	if err == nil {
		m.addRead(out.ConsumedCapacity)
	}
	return out, err
}

// BatchGetItem reads several items.
func (m *Meter) BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
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
	in.ReturnConsumedCapacity = total
	out, err := m.Client.Query(ctx, in, opts...)
	if err == nil {
		m.addRead(out.ConsumedCapacity)
	}
	return out, err
}

// PutItem writes one item.
func (m *Meter) PutItem(ctx context.Context, in *dynamodb.PutItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
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
	in.ReturnConsumedCapacity = total
	out, err := m.Client.TransactWriteItems(ctx, in, opts...)
	if err == nil {
		for i := range out.ConsumedCapacity {
			m.addWrite(&out.ConsumedCapacity[i])
		}
	}
	return out, err
}
